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


async def bulk_insert_commit_files(db: AsyncSession, commit_files: list[dict]):
    """
    Bulk insert commit files using PostgreSQL COPY.
    commit_files: list of dicts with keys: id, commit_id, file_path, additions, deletions, change_type
    """
    if not commit_files:
        return
    
    connection = await db.connection()
    raw_conn = await connection.get_raw_connection()
    
    buffer = io.StringIO()
    for cf in commit_files:
        row = "\t".join([
            str(cf['id']),
            str(cf['commit_id']),
            str(cf['file_path']),
            str(cf.get('additions', 0)),
            str(cf.get('deletions', 0)),
            str(cf.get('change_type', 'MODIFIED')),
        ]) + "\n"
        buffer.write(row)
    
    buffer.seek(0)
    buffer_bytes = io.BytesIO(buffer.getvalue().encode('utf-8'))
    buffer_bytes.seek(0)
    
    result = await raw_conn.driver_connection.copy_to_table(
        'commit_files',
        source=buffer_bytes,
        columns=['id', 'commit_id', 'file_path', 'additions', 'deletions', 'change_type'],
        format='csv',
        delimiter='\t',
        null=''
    )
    print(f"Commit files bulk insert complete. Result: {result}")
    

async def bulk_insert_prs(db: AsyncSession, prs: list[dict]):
    """Bulk insert pull requests using PostgreSQL COPY."""
    if not prs:
        return

    connection = await db.connection()
    raw_conn = await connection.get_raw_connection()

    buffer = io.StringIO()
    for pr in prs:
        title = (pr.get('title') or '').replace('\t', ' ').replace('\n', ' ')
        row = "\t".join([
            str(pr['id']),
            str(pr['repo_id']),
            str(pr['github_id']),
            str(pr['number']),
            title,
            str(pr.get('state', '')),
            str(pr.get('author_login', '')),
            str(pr.get('created_at', '')),
            str(pr.get('closed_at', '')),
            str(pr.get('merged_at', '')),
        ]) + "\n"
        buffer.write(row)

    buffer.seek(0)
    buffer_bytes = io.BytesIO(buffer.getvalue().encode('utf-8'))
    buffer_bytes.seek(0)

    result = await raw_conn.driver_connection.copy_to_table(
        'pull_requests',
        source=buffer_bytes,
        columns=['id', 'repo_id', 'github_id', 'number', 'title', 'state',
                 'author_login', 'created_at', 'closed_at', 'merged_at'],
        format='csv',
        delimiter='\t',
        null=''
    )
    print(f"PR bulk insert complete. Result: {result}")


async def bulk_insert_pr_files(db: AsyncSession, pr_files: list[dict]):
    """Bulk insert PR file records using PostgreSQL COPY.
    pr_files: list of dicts with keys: id, pr_id, path, additions, deletions, change_type
    """
    if not pr_files:
        return

    connection = await db.connection()
    raw_conn = await connection.get_raw_connection()

    buffer = io.StringIO()
    for pf in pr_files:
        row = "\t".join([
            str(pf['id']),
            str(pf['pr_id']),
            str(pf['path']),
            str(pf.get('additions', 0)),
            str(pf.get('deletions', 0)),
            str(pf.get('change_type', 'MODIFIED')),
        ]) + "\n"
        buffer.write(row)

    buffer.seek(0)
    buffer_bytes = io.BytesIO(buffer.getvalue().encode('utf-8'))
    buffer_bytes.seek(0)

    result = await raw_conn.driver_connection.copy_to_table(
        'pr_files',
        source=buffer_bytes,
        columns=['id', 'pr_id', 'path', 'additions', 'deletions', 'change_type'],
        format='csv',
        delimiter='\t',
        null='',
    )
    print(f"PR files bulk insert complete. Result: {result}")


async def bulk_insert_issues(db: AsyncSession, issues: list[dict]):
    # TBD
    pass
