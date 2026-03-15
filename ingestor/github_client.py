import httpx

GRAPHQL_URL = "https://api.github.com/graphql"

BACKFILL_COMMITS_QUERY = """
query ($owner: String!, $name: String!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100, after: $cursor) {
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
