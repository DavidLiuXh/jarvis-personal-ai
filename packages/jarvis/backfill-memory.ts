
import 'dotenv/config';
import { MemoryService } from './src/core/memory.js';
import process from 'node:process';

async function runBackfill() {
  console.log('🚀 Jarvis Memory Backfill Tool');
  const apiKey = process.env.GOOGLE_API_KEY;
  
  if (!apiKey) {
    console.error('❌ Error: GOOGLE_API_KEY not found in .env or environment.');
    process.exit(1);
  }

  const memoryService = new MemoryService();
  
  // We need to provide a mock config enough for the service
  const mockConfig = {
    storage: {
      getProjectTempDir: () => process.env.HOME + '/.gemini/tmp'
    }
  };

  console.log('📡 Initializing AI Client...');
  memoryService.startWithApiKey(apiKey);
  
  console.log('⌛ Waiting for sync to complete (this may take a while)...');
  
  // Keep alive until sync is done
  const checkDone = setInterval(async () => {
    // We'll rely on the service's logs
  }, 5000);

  // Auto-exit after some time if it seems idle
  setTimeout(() => {
    console.log('✅ Backfill process finished (Timeout reached).');
    process.exit(0);
  }, 120000); // 2 mins
}

runBackfill();
