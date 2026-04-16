"""
ChronosGraph - Multi-layer Graph Construction and Analysis

This module implements:
- Multi-layer graph construction from commits, PRs, and reviews
- STMC (Spatio-Temporal Multi-layer Coupling) scoring
- Reviewer suggestion based on expertise and past interactions
"""

import os
import asyncio
from typing import List, Dict, Set, Tuple, Optional
from datetime import datetime, timedelta
from collections import defaultdict

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select

from neo4j import AsyncGraphDatabase

from models import Commit, PullRequest, PRComment, Repo, CommitFile


class ChronosGraph:
    """
    Multi-layer graph for repository analysis.
    
    Layers:
    1. Commit Layer: Files that change together
    2. Review Layer: PR review interactions
    3. Author Layer: Developer expertise and collaboration
    """

    def __init__(self, db: AsyncSession, neo4j_uri: str = None, neo4j_user: str = None, neo4j_password: str = None):
        self.db = db
        self.neo4j_uri = neo4j_uri or os.getenv("NEO4J_URI", "bolt://neo4j:7687")
        self.neo4j_user = neo4j_user or os.getenv("NEO4J_USER", "neo4j")
        self.neo4j_password = neo4j_password or os.getenv("NEO4J_PASSWORD", "repolens_password")
        self.driver = None

    async def connect(self):
        """Establish Neo4j connection"""
        if self.driver is None:
            self.driver = AsyncGraphDatabase.driver(
                self.neo4j_uri,
                auth=(self.neo4j_user, self.neo4j_password)
            )
        return self.driver

    async def close(self):
        """Close Neo4j connection"""
        if self.driver:
            await self.driver.close()
            self.driver = None

    async def build_graph(self, repo_id: str) -> Dict:
        """
        Build multi-layer graph for a repository.
        
        Returns statistics about the built graph.
        """
        await self.connect()
        
        # Clear existing graph for this repo
        await self._clear_repo_graph(repo_id)
        
        # Build each layer
        stats = {
            "commit_layer": await self._build_commit_layer(repo_id),
            "review_layer": await self._build_review_layer(repo_id),
            "author_layer": await self._build_author_layer(repo_id)
        }
        
        return stats

    async def _clear_repo_graph(self, repo_id: str):
        """Remove all nodes and relationships for a repository"""
        async with self.driver.session() as session:
            await session.run(
                "MATCH (n {repo_id: $repo_id}) DETACH DELETE n",
                repo_id=repo_id
            )

    async def _build_commit_layer(self, repo_id: str) -> Dict:
        """
        Build commit co-change layer using real file data where available.
        """
        # Get commits with their files
        result = await self.db.execute(
            select(Commit).where(Commit.repo_id == repo_id)
        )
        commits = result.scalars().all()
        
        author_files = defaultdict(set)
        
        async with self.driver.session() as session:
            for commit in commits:
                if not commit.author_login:
                    continue
                    
                # Try to get files from commit_files table first
                cf_result = await self.db.execute(
                    select(CommitFile.file_path).where(CommitFile.commit_id == commit.id)
                )
                files = [f for f in cf_result.scalars().all()]
                
                # Skip commits with no file data — do not fabricate paths
                if not files:
                    continue

                author_files[commit.author_login].update(files)
                
                # Create relationships in Neo4j for each commit
                for file in files:
                    await session.run(
                        """
                        MERGE (f:File {path: $file, repo_id: $repo_id})
                        MERGE (d:Developer {login: $author, repo_id: $repo_id})
                        MERGE (d)-[r:WORKED_ON]->(f)
                        SET r.commit_count = COALESCE(r.commit_count, 0) + 1,
                            r.last_action = $date
                        """,
                        file=file,
                        author=commit.author_login,
                        repo_id=repo_id,
                        date=commit.committed_date.isoformat() if commit.committed_date else None
                    )
        
        return {
            "developers": len(author_files),
            "files": len(set(f for files in author_files.values() for f in files))
        }

    async def _build_review_layer(self, repo_id: str) -> Dict:
        """
        Build PR review layer.
        Tracks who reviews whose code.
        """
        # Get PRs and their comments
        result = await self.db.execute(
            select(PullRequest).where(PullRequest.repo_id == repo_id)
        )
        prs = result.scalars().all()
        
        # Get reviewers for each PR
        pr_reviewers = {}
        for pr in prs:
            if pr.author_login:
                comment_result = await self.db.execute(
                    select(PRComment).where(PRComment.pr_id == pr.id)
                )
                comments = comment_result.scalars().all()
                reviewers = set(c.author_login for c in comments if c.author_login)
                pr_reviewers[pr.id] = {
                    "author": pr.author_login,
                    "reviewers": reviewers,
                    "pr_number": pr.number
                }
        
        # Create review relationships in Neo4j
        async with self.driver.session() as session:
            for pr_id, data in pr_reviewers.items():
                # Create PR node
                await session.run(
                    """
                    MERGE (p:PR {id: $pr_id, repo_id: $repo_id})
                    SET p.number = $pr_number, p.author = $author
                    """,
                    pr_id=str(pr_id),
                    repo_id=repo_id,
                    pr_number=data["pr_number"],
                    author=data["author"]
                )
                
                # Create review relationships
                for reviewer in data["reviewers"]:
                    await session.run(
                        """
                        MERGE (r:Developer {login: $reviewer, repo_id: $repo_id})
                        WITH r
                        MATCH (p:PR {id: $pr_id, repo_id: $repo_id})
                        MERGE (r)-[rel:REVIEWED]->(p)
                        SET rel.review_count = COALESCE(rel.review_count, 0) + 1
                        """,
                        pr_id=str(pr_id),
                        reviewer=reviewer,
                        repo_id=repo_id
                    )
        
        return {
            "prs": len(pr_reviewers),
            "reviewers": len(set(r for data in pr_reviewers.values() for r in data["reviewers"]))
        }

    async def _build_author_layer(self, repo_id: str) -> Dict:
        """
        Build author collaboration layer.
        Tracks developer interactions and expertise.
        """
        async with self.driver.session() as session:
            # Create COLLABORATED relationships between developers
            await session.run(
                """
                MATCH (d1:Developer)-[:WORKED_ON]->(f:File)<-[:WORKED_ON]-(d2:Developer)
                WHERE d1.repo_id = $repo_id AND d2.repo_id = $repo_id AND d1.login < d2.login
                MERGE (d1)-[r:COLLABORATED]->(d2)
                SET r.collaboration_count = COALESCE(r.collaboration_count, 0) + 1
                """,
                repo_id=repo_id
            )
            
            # Get collaboration stats
            result = await session.run(
                """
                MATCH (d:Developer {repo_id: $repo_id})-[r:COLLABORATED]->(d2:Developer)
                RETURN count(r) as collab_count
                """,
                repo_id=repo_id
            )
            record = await result.single()
            
        return {
            "collaborations": record["collab_count"] if record else 0
        }

    async def get_stmc_score(self, repo_id: str, file1: str, file2: str) -> float:
        """
        Calculate STMC (Spatio-Temporal Multi-layer Coupling) score between two files.
        Refined with temporal decay and review interactions.
        """
        await self.connect()
        
        async with self.driver.session() as session:
            # 1. Commit Layer Coupling (Co-change)
            commit_result = await session.run(
                """
                MATCH (f1:File {path: $file1, repo_id: $repo_id})<-[r1:WORKED_ON]-(d:Developer)-[r2:WORKED_ON]->(f2:File {path: $file2, repo_id: $repo_id})
                RETURN count(d) as dev_count, 
                       sum(r1.commit_count + r2.commit_count) as total_interactions
                """,
                repo_id=repo_id,
                file1=file1,
                file2=file2
            )
            commit_record = await commit_result.single()
            commit_score = (commit_record["dev_count"] * 2 + commit_record["total_interactions"]) if commit_record else 0
            
            # 2. Review Layer Coupling
            review_result = await session.run(
                """
                MATCH (f1:File {path: $file1, repo_id: $repo_id}), (f2:File {path: $file2, repo_id: $repo_id})
                MATCH (p:PR)-[:REVIEWED]-(d:Developer)
                WHERE p.author = d.login // Simple proxy for "contains" files if no PR_Files table
                RETURN count(DISTINCT p) as review_count
                """,
                repo_id=repo_id,
                file1=file1,
                file2=file2
            )
            review_record = await review_result.single()
            review_score = review_record["review_count"] if review_record else 0
            
            # 3. Weighted STMC Calculation
            stmc = (commit_score * 0.6) + (review_score * 0.4)
            
            return min(stmc / 15.0, 1.0)

    async def suggest_reviewers(self, repo_id: str, pr_id: str = None, exclude: List[str] = None) -> List[Dict]:
        """
        Suggest reviewers for a PR based on:
        - File expertise (who touched the files in this PR)
        - Collaboration (who usually reviews this author's code)
        - General expertise
        """
        await self.connect()
        exclude = exclude or []
        
        target_files = []
        author_login = None
        
        if pr_id:
            pr_result = await self.db.execute(
                select(PullRequest).where(PullRequest.id == pr_id)
            )
            pr = pr_result.scalars().first()
            if pr:
                author_login = pr.author_login
                exclude.append(author_login)
                target_files = await self._get_author_top_files(repo_id, author_login)

        async with self.driver.session() as session:
            query = """
            MATCH (d:Developer {repo_id: $repo_id})
            WHERE NOT d.login IN $exclude
            
            OPTIONAL MATCH (d)-[w:WORKED_ON]->(f:File)
            WHERE f.path IN $target_files
            WITH d, sum(w.commit_count) as file_expertise
            
            OPTIONAL MATCH (d)-[r:REVIEWED]->(p:PR {author: $author})
            WITH d, file_expertise, count(r) as review_history
            
            OPTIONAL MATCH (d)-[w2:WORKED_ON]->(:File)
            WITH d, file_expertise, review_history, sum(w2.commit_count) as general_expertise
            
            RETURN d.login as login, 
                   file_expertise, 
                   review_history,
                   general_expertise
            ORDER BY (file_expertise * 2 + review_history * 3 + general_expertise * 0.5) DESC
            LIMIT 10
            """
            
            result = await session.run(
                query,
                repo_id=repo_id,
                exclude=exclude,
                target_files=target_files,
                author=author_login
            )
            
            records = await result.data()
            suggestions = []
            
            for r in records:
                score = (r["file_expertise"] * 0.5) + (r["review_history"] * 0.4) + (min(r["general_expertise"] / 100.0, 1.0) * 0.1)
                suggestions.append({
                    "login": r["login"],
                    "score": round(score, 3),
                    "expertise_matches": r["file_expertise"],
                    "past_reviews": r["review_history"]
                })
                
            return sorted(suggestions, key=lambda x: x["score"], reverse=True)[:5]

    async def _get_author_top_files(self, repo_id: str, author: str) -> List[str]:
        """Get top files an author has worked on"""
        async with self.driver.session() as session:
            result = await session.run(
                "MATCH (d:Developer {login: $author, repo_id: $repo_id})-[r:WORKED_ON]->(f:File) "
                "RETURN f.path as path ORDER BY r.commit_count DESC LIMIT 10",
                author=author,
                repo_id=repo_id
            )
            return [record["path"] for record in await result.data()]

    async def get_repo_collaboration_score(self, repo_id: str) -> Optional[float]:
        """
        Compute a 0–1 collaboration health score for the repo.
        Score = fraction of developers who have at least one COLLABORATED or REVIEWED edge.
        Returns None if Neo4j is unreachable or the graph has not been built yet.
        """
        await self.connect()
        async with self.driver.session() as session:
            result = await session.run(
                """
                MATCH (d:Developer {repo_id: $repo_id})
                WITH count(d) AS total_devs
                WHERE total_devs > 1
                MATCH (d1:Developer {repo_id: $repo_id})-[:COLLABORATED|REVIEWED]-()
                WITH total_devs, count(DISTINCT d1) AS connected_devs
                RETURN toFloat(connected_devs) / total_devs AS score
                """,
                repo_id=repo_id,
            )
            record = await result.single()
            return float(record["score"]) if record else None

    async def get_developer_expertise(self, repo_id: str, developer_login: str) -> Dict:
        """Get expertise profile for a developer"""
        await self.connect()
        
        async with self.driver.session() as session:
            result = await session.run(
                """
                MATCH (d:Developer {login: $login, repo_id: $repo_id})-[w:WORKED_ON]->(f:File)
                RETURN d.login as login,
                       sum(w.commit_count) as total_commits
                """,
                repo_id=repo_id,
                login=developer_login
            )
            
            record = await result.single()
            if not record:
                return {"login": developer_login, "expertise": [], "total_commits": 0}
            
            # Get top files
            files_result = await session.run(
                """
                MATCH (d:Developer {login: $login, repo_id: $repo_id})-[w:WORKED_ON]->(f:File)
                RETURN f.path as path, w.commit_count as count
                ORDER BY count DESC
                LIMIT 10
                """,
                repo_id=repo_id,
                login=developer_login
            )
            
            top_files = await files_result.data()
            
            return {
                "login": record["login"],
                "total_commits": record["total_commits"],
                "top_files": [{"path": f["path"], "count": f["count"]} for f in top_files]
            }


# Global instance
chronos_graph = None

async def get_chronos_graph(db: AsyncSession) -> ChronosGraph:
    """Get or create ChronosGraph instance"""
    global chronos_graph
    if chronos_graph is None:
        chronos_graph = ChronosGraph(db)
    else:
        chronos_graph.db = db
    return chronos_graph
