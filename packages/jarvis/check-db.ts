
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import path from 'node:path';
import os from 'node:os';

async function checkDatabase() {
  const dbPath = path.join(os.homedir(), '.gemini', 'jarvis', 'memory.db');
  console.log('Checking database at:', dbPath);
  
  try {
    const db = new Database(dbPath);
    sqliteVec.load(db);
    
    const count = db.prepare('SELECT count(*) as c FROM memories').get();
    console.log('Total memories in database:', count.c);
    
    const files = db.prepare('SELECT count(*) as c FROM processed_files').get();
    console.log('Total processed files:', files.c);
    
    if (count.c > 0) {
      console.log('\nLast 3 entries:');
      const entries = db.prepare('SELECT text FROM memories ORDER BY id DESC LIMIT 3').all();
      entries.forEach((e, i) => console.log(`[${i+1}] ${e.text.substring(0, 100)}...`));
    }
    
    db.close();
  } catch (err) {
    console.error('Database check failed:', err);
  }
}

checkDatabase();
