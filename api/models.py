from sqlalchemy import Column, String, Integer, DateTime, JSON, ForeignKey, Boolean, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid
from database import Base

class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    github_id = Column(String(64), unique=True, index=True, nullable=False)
    login = Column(String(255), nullable=False)
    email = Column(String(255))
    avatar_url = Column(String(255))
    github_token = Column(String(255), nullable=False)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    updated_at = Column(DateTime(timezone=True), onupdate=func.now())

class Repo(Base):
    __tablename__ = "repos"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    github_id = Column(String(64), unique=True, index=True, nullable=False)
    owner = Column(String(255), nullable=False)
    name = Column(String(255), nullable=False)
    default_branch = Column(String(255), nullable=False, default="main")
    synced_at = Column(DateTime(timezone=True))
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    config = Column(JSON)

class UserRepo(Base):
    __tablename__ = "user_repos"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    repo_id = Column(UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), nullable=False)
    role = Column(String(32), default="admin") # User's derived permission level

class Commit(Base):
    """Stores historical commit data for the CoChangeOracle"""
    __tablename__ = "commits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), index=True)
    oid = Column(String, index=True) # Git SHA
    __table_args__ = (UniqueConstraint('repo_id', 'oid'),)
    message = Column(String)
    author_email = Column(String, index=True)
    author_login = Column(String, index=True)
    committed_date = Column(DateTime(timezone=True), index=True)
    additions = Column(Integer)
    deletions = Column(Integer)
    created_at = Column(DateTime(timezone=True), server_default=func.now())
    
    # We will compute these metrics later via cron job
    risk_score = Column(Integer, nullable=True) 

class PullRequest(Base):
    """Stores PRs for the ChronosGraph and general ML processing"""
    __tablename__ = "pull_requests"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), index=True)
    github_id = Column(String, unique=True, index=True)
    number = Column(Integer, index=True)
    title = Column(String)
    state = Column(String) # OPEN, CLOSED, MERGED
    author_login = Column(String, index=True)
    created_at = Column(DateTime(timezone=True))
    closed_at = Column(DateTime(timezone=True), nullable=True)
    merged_at = Column(DateTime(timezone=True), nullable=True)
    
    # Risk calculation fields
    predicted_risk_score = Column(Integer, nullable=True)
    explanation = Column(JSON, nullable=True)


class PRComment(Base):
    """Stores textual reviews on PRs for ChronosGraph Reviewer Suggestion"""
    __tablename__ = "pr_comments"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    pr_id = Column(UUID(as_uuid=True), ForeignKey("pull_requests.id", ondelete="CASCADE"), index=True)
    github_id = Column(String, unique=True)
    author_login = Column(String, index=True)
    body = Column(String)
    created_at = Column(DateTime(timezone=True))


class Issue(Base):
    """Stores Issues to track bug velocity and link them to PRs"""
    __tablename__ = "issues"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), index=True)
    github_id = Column(String, unique=True, index=True)
    number = Column(Integer, index=True)
    title = Column(String)
    state = Column(String)
    author_login = Column(String)
    created_at = Column(DateTime(timezone=True))
    closed_at = Column(DateTime(timezone=True), nullable=True)


class CIRun(Base):
    """Stores workflow execution data for the TestPulse engine"""
    __tablename__ = "ci_runs"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey("repos.id", ondelete="CASCADE"), index=True)
    github_id = Column(String, unique=True, index=True)
    name = Column(String)
    head_sha = Column(String, index=True)  # The commit it ran on
    status = Column(String) # completed, in_progress
    conclusion = Column(String, index=True) # success, failure, neutral, cancelled
    created_at = Column(DateTime(timezone=True))
    updated_at = Column(DateTime(timezone=True))
    
    # Store TestPulse flaky test classifications here
    analysis_results = Column(JSON, nullable=True)
    
    
class ArchAnalysis(Base):
    __tablename__ = 'arch_analysis'
    
    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), ForeignKey('repos.id', ondelete='CASCADE'), index=True)
    violations = Column(JSON, nullable=True)
    import_cycles = Column(JSON, nullable=True)
    parsed_at = Column(DateTime(timezone=True), server_default=func.now())
