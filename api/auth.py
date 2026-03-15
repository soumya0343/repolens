from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
import httpx
import os
import jwt
import datetime

from database import get_db
from models import User

router = APIRouter(prefix="/auth/github", tags=["auth"])

GITHUB_CLIENT_ID = os.getenv("GITHUB_CLIENT_ID", "local_client_placeholder")
GITHUB_CLIENT_SECRET = os.getenv("GITHUB_CLIENT_SECRET", "local_secret_placeholder")
JWT_SECRET = os.getenv("JWT_SECRET", "super_secret_jwt_key")
FRONTEND_URL = os.getenv("FRONTEND_URL", "http://localhost:5173")

@router.get("/")
async def github_login():
    """Initiate GitHub OAuth flow"""
    return {
        "redirect_url": f"https://github.com/login/oauth/authorize?client_id={GITHUB_CLIENT_ID}&scope=repo read:org read:user"
    }

@router.get("/callback")
async def github_callback(code: str, db: AsyncSession = Depends(get_db)):
    """Callback for GitHub OAuth"""
    token_url = "https://github.com/login/oauth/access_token"
    headers = {"Accept": "application/json"}
    data = {
        "client_id": GITHUB_CLIENT_ID,
        "client_secret": GITHUB_CLIENT_SECRET,
        "code": code
    }
    
    async with httpx.AsyncClient() as client:
        # If running without real credentials, mock the process for local development
        if GITHUB_CLIENT_ID == "local_client_placeholder":
            # Mock dev login
            user_data = {"id": 12345, "login": "dev_user", "email": "dev@repolens.com", "avatar_url": ""}
            access_token = "mock_github_token"
        else:
            response = await client.post(token_url, json=data, headers=headers)
            token_data = response.json()
            if "access_token" not in token_data:
                raise HTTPException(status_code=400, detail="Invalid auth code")
                
            access_token = token_data["access_token"]
            
            user_response = await client.get("https://api.github.com/user", headers={"Authorization": f"Bearer {access_token}"})
            user_data = user_response.json()

        # Upsert User into DB
        github_id_str = str(user_data["id"])
        result = await db.execute(select(User).where(User.github_id == github_id_str))
        user = result.scalars().first()

        if user:
            user.login = user_data.get("login", user.login)
            user.email = user_data.get("email", user.email)
            user.avatar_url = user_data.get("avatar_url", user.avatar_url)
            user.github_token = access_token
        else:
            user = User(
                github_id=github_id_str,
                login=user_data.get("login", ""),
                email=user_data.get("email"),
                avatar_url=user_data.get("avatar_url"),
                github_token=access_token
            )
            db.add(user)
        
        await db.commit()
        await db.refresh(user)

        # Create internal JWT session token
        session_token = jwt.encode({
            "sub": str(user.id),
            "exp": datetime.datetime.utcnow() + datetime.timedelta(days=30)
        }, JWT_SECRET, algorithm="HS256")
        
        return {"status": "success", "token": session_token}
