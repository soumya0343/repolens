import asyncio
import httpx

GRAPHQL_URL = "https://api.github.com/graphql"
REST_URL = "https://api.github.com"

BACKFILL_COMMITS_QUERY = """
query ($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 50, after: $cursor) {
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              oid
              message
              committedDate
              additions
              deletions
              author {
                user {
                  login
                }
                email
              }
              parents {
                totalCount
              }
            }
          }
        }
      }
    }
  }
}
"""


async def fetch_commits_batch(token: str, owner: str, name: str, cursor: str = None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    
    variables = {
        "owner": owner,
        "name": name,
        "cursor": cursor
    }
    
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GRAPHQL_URL, 
            json={"query": BACKFILL_COMMITS_QUERY, "variables": variables},
            headers=headers,
            timeout=30.0
        )
        response.raise_for_status()
        return response.json()


BACKFILL_PRS_QUERY = """
query ($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequests(first: 50, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        databaseId
        number
        title
        state
        createdAt
        closedAt
        mergedAt
        author {
          login
        }
        comments(first: 20) {
          nodes {
            databaseId
            author { login }
            body
            createdAt
          }
        }
      }
    }
  }
}
"""


async def fetch_prs_batch(token: str, owner: str, name: str, cursor: str = None):
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json"
    }
    variables = {"owner": owner, "name": name, "cursor": cursor}
    async with httpx.AsyncClient() as client:
        response = await client.post(
            GRAPHQL_URL,
            json={"query": BACKFILL_PRS_QUERY, "variables": variables},
            headers=headers,
            timeout=30.0
        )
        response.raise_for_status()
        return response.json()


async def fetch_commit_files(token: str, owner: str, name: str, commit_sha: str, max_retries: int = 3):
    """Fetch files changed in a specific commit using GitHub REST API.

    Returns empty list for merge commits (parents > 1) or missing commits (404).
    Raises on non-retryable errors after exhausting retries.
    """
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json"
    }

    url = f"{REST_URL}/repos/{owner}/{name}/commits/{commit_sha}"
    delay = 1.0

    async with httpx.AsyncClient() as client:
        for attempt in range(max_retries):
            response = await client.get(url, headers=headers, timeout=30.0)

            if response.status_code == 404:
                # Commit not found — safe to skip
                return []

            if response.status_code in (403, 429):
                retry_after = int(response.headers.get("Retry-After", delay))
                print(f"[WARN] Rate limited fetching files for {commit_sha} — waiting {retry_after}s (attempt {attempt + 1}/{max_retries})")
                await asyncio.sleep(retry_after)
                delay = min(delay * 2, 60)
                continue

            response.raise_for_status()
            data = response.json()

            # Merge commits legitimately have no file diff — skip silently
            parents = data.get("parents", [])
            if len(parents) > 1:
                return []

            files = []
            for f in data.get("files", []):
                files.append({
                    "path": f["filename"],
                    "additions": f.get("additions", 0),
                    "deletions": f.get("deletions", 0),
                    "change_type": f.get("status", "modified").upper(),
                })
            return files

        raise RuntimeError(f"Failed to fetch files for {commit_sha} after {max_retries} attempts (rate limited)")
