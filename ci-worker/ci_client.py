import httpx
import os
import zipfile
import io

REST_URL = "https://api.github.com"

async def fetch_workflow_runs(token: str, owner: str, name: str, days_back: int = 90):
    """Fetch the list of GitHub Actions workflow runs for the last N days"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    # We use a large per_page; in reality we would handle pagination
    url = f"{REST_URL}/repos/{owner}/{name}/actions/runs?per_page=100"
    
    async with httpx.AsyncClient() as client:
        response = await client.get(url, headers=headers)
        response.raise_for_status()
        return response.json().get("workflow_runs", [])

async def download_run_logs(token: str, owner: str, name: str, run_id: int):
    """Download the zipped logs for a specific run"""
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github.v3+json"
    }
    
    url = f"{REST_URL}/repos/{owner}/{name}/actions/runs/{run_id}/logs"
    
    async with httpx.AsyncClient() as client:
        # The API redirects to an AWS S3 URL for the zip file. httpx follows redirects by default.
        response = await client.get(url, headers=headers, follow_redirects=True)
        
        if response.status_code == 404:
            # Logs are expired or unavailable
            return None
            
        response.raise_for_status()
        
        # Read the zip file into memory
        zip_bytes = io.BytesIO(response.content)
        logs_content = {}
        
        try:
            with zipfile.ZipFile(zip_bytes) as archive:
                for file_name in archive.namelist():
                    # We only care about the actual step txt files, not the summary directories
                    if file_name.endswith('.txt'):
                        logs_content[file_name] = archive.read(file_name).decode('utf-8', errors='ignore')
        except zipfile.BadZipFile:
            print(f"Bad zip file for run {run_id}")
            
        return logs_content
