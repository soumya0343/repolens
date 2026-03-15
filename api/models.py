from sqlalchemy import Column, String, Integer, DateTime, JSON, ForeignKey, Boolean
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
