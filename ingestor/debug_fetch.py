import asyncio
import os
import github_client

async def main():
    token = os.getenv('GITHUB_TOKEN')
    if not token:
        raise ValueError('GITHUB_TOKEN environment variable not set')
    data = await github_client.fetch_commits_batch(token, 'soumya0343', 'soumya0343')
    import json
    print(json.dumps(data, indent=2)[:2000])

asyncio.run(main())
