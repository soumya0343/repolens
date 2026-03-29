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


async def fetch_commit_files(token: str, owner: str, name: str, commit_sha: str):
    """Fetch files changed in a specific commit using GitHub REST API"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    url = f"{REST_URL}/repos/{owner}/{name}/commits/{commit_sha}"
    
    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers, timeout=30.0)
        if response.status_code == 404:
            return []  # Commit might not exist or be a merge commit
        response.raise_for_status()
        data = response.json()
        
        # Extract file information
        files = []
        for f in data.get('files', []):
            files.append({
                'path': f['filename'],
                'additions': f.get('additions', 0),
                'deletions': f.get('deletions', 0),
                'change_type': f.get('status', 'modified').upper()  # added, removed, modified
            })
        
        return files
