from __future__ import annotations

import os
from urllib.parse import urlparse

import psycopg
from psycopg import sql
from dotenv import load_dotenv


def main() -> None:
    load_dotenv()
    database_name = os.environ.get("DATABASE_NAME", "ai_novel_mvp")
    admin_url = os.environ.get("POSTGRES_ADMIN_URL")
    if not admin_url:
        raise SystemExit("缺少 POSTGRES_ADMIN_URL 环境变量")

    parsed = urlparse(admin_url)
    admin_db = parsed.path.lstrip("/") or "postgres"

    with psycopg.connect(admin_url, autocommit=True) as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT 1 FROM pg_database WHERE datname = %s", (database_name,))
            exists = cur.fetchone() is not None
            if exists:
                print(f"数据库已存在: {database_name} (admin db: {admin_db})")
                return

            cur.execute(sql.SQL("CREATE DATABASE {}") .format(sql.Identifier(database_name)))
            print(f"数据库已创建: {database_name} (admin db: {admin_db})")


if __name__ == "__main__":
    main()