from sqlalchemy import Column, String, Integer, DateTime, UUID
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.sql import func
import uuid
from database import Base

class Commit(Base):
    __tablename__ = "commits"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    repo_id = Column(UUID(as_uuid=True), index=True)
    oid = Column(String, index=True)
    message = Column(String)
    risk_score = Column(Integer, nullable=True)
