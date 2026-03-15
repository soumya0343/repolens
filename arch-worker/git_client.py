import os
from git import Repo
import shutil

WORK_DIR = os.getenv("ARCH_WORK_DIR", "/tmp/repolens_workdir")

def clone_repository(token: str, owner: str, name: str, branch: str = "main"):
    """
    Shallow clones a GitHub repository locally for architecture parsing.
    The token is embedded in the HTTPS URL for authentication.
    """
    repo_dir = os.path.join(WORK_DIR, f"{owner}_{name}")
    
    # Clean up previous runs if necessary
    if os.path.exists(repo_dir):
        shutil.rmtree(repo_dir)
        
    os.makedirs(repo_dir, exist_ok=True)
    
    clone_url = f"https://x-access-token:{token}@github.com/{owner}/{name}.git"
    
    print(f"Cloning {owner}/{name} (branch: {branch})...")
    
    # Perform a shallow clone (depth=1) as we only need the current snapshot for structural analysis
    Repo.clone_from(url=clone_url, to_path=repo_dir, depth=1, branch=branch)
    
    print(f"Successfully cloned to {repo_dir}")
    return repo_dir

def cleanup_repository(repo_dir: str):
    """Deletes the locally cloned repository to save disk space"""
    if os.path.exists(repo_dir):
        shutil.rmtree(repo_dir)
        print(f"Cleaned up {repo_dir}")
