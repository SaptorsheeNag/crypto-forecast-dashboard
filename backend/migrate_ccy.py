# backend/migrate_ccy.py
import os, sqlite3

DB_PATH = os.getenv("DB_PATH", "app.db")  # <-- matches app.py

def add_column_if_missing(table, column_def):
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute(f"PRAGMA table_info({table})")
    cols = [row[1] for row in cur.fetchall()]
    colname = column_def.split()[0]
    if colname not in cols:
        print(f"Adding column '{column_def}' to '{table}'...")
        cur.execute(f"ALTER TABLE {table} ADD COLUMN {column_def}")
        conn.commit()
    else:
        print(f"Column '{colname}' already exists in '{table}', skipping.")
    conn.close()

if __name__ == "__main__":
    for t in ("holdings","alerts","goals"):
        # Use NOT NULL if you like; both work because DEFAULT is provided.
        add_column_if_missing(t, "ccy TEXT NOT NULL DEFAULT 'USD'")
    print("Migration complete ✅")
