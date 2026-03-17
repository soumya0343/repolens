import io
from sqlalchemy.ext.asyncio import AsyncSession
from models import Commit, PullRequest, PRComment, Issue, CIRun

async def bulk_insert_commits(db: AsyncSession, commits: list[dict]):
    """
    High-performance bulk insertion using PostgreSQL COPY command.
    Bypasses the SQLAlchemy ORM for maximum throughput when importing history.
    """
    if not commits:
        return
        
    connection = await db.connection()
    # asyncpg raw connection
    raw_conn = await connection.get_raw_connection()
    
    # Create an in-memory CSV-like buffer for the COPY command
    buffer = io.StringIO()
    for commit in commits:
        # Expected format matching the `commits` table columns
        # id, repo_id, oid, message, author_email, author_login, committed_date, additions, deletions
        message = commit.get('message', '')
        message = message.replace('\t', ' ').replace('\n', ' ')

        row = "\t".join([
            str(commit['id']),
            str(commit['repo_id']),
            str(commit['oid']),
            message,
            str(commit.get('author_email', '')),
            str(commit.get('author_login', '')),
            str(commit['committed_date']),
            str(commit.get('additions', 0)),
            str(commit.get('deletions', 0)),
        ]) + "\n"

        buffer.write(row)
        
    buffer.seek(0)
    # asyncpg expects a bytes-like object for COPY source
    buffer_bytes = io.BytesIO(buffer.getvalue().encode('utf-8'))
    buffer_bytes.seek(0)

    # Execute the raw COPY
    # We use COPY format 'csv' with a tab delimiter handling
    result = await raw_conn.driver_connection.copy_to_table(
        'commits',
        source=buffer_bytes,
        columns=['id', 'repo_id', 'oid', 'message', 'author_email', 'author_login', 'committed_date', 'additions', 'deletions'],
        format='csv',
        delimiter='\t',
        null=''
    )
    print(f"Bulk insert complete. Result: {result}")
    
async def bulk_insert_prs(db: AsyncSession, prs: list[dict]):
    # TBD
    pass

async def bulk_insert_issues(db: AsyncSession, issues: list[dict]):
    # TBD
    pass
