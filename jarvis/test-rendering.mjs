import WebSocket from 'ws';

async function runRenderingTest() {
  console.log('🚀 Starting Rendering Integration Test...');
  const ws = new WebSocket('ws://localhost:3000');

  ws.on('open', () => {
    console.log('✅ Connection established. Sending Markdown payload...');
    // Simulate a complex response with code blocks
    ws.send(JSON.stringify({
      type: 'chat',
      sessionId: 'render-test-' + Date.now(),
      payload: 'Show me a TypeScript example of a greeting function.'
    }));
  });

  let receivedChunks = 0;
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    
    if (msg.type === 'stream') {
      receivedChunks++;
      const payload = msg.payload;
      
      if (payload.type === 'content') {
        console.log(`📥 Received content chunk ${receivedChunks}.`);
      } else if (payload.type === 'thought') {
        console.log(`📥 Received thought: ${payload.value.subject}`);
      } else if (payload.type === 'tool_call_request') {
        console.log(`📥 Received tool call: ${payload.value.name}`);
      }
    } else if (msg.type === 'done') {
      console.log('🎉 Test successful! Received ' + receivedChunks + ' events.');
      process.exit(0);
    } else if (msg.type === 'error') {
      console.error('❌ SERVER ERROR:', msg.message);
      process.exit(1);
    }
  });

  ws.on('error', (err) => {
    console.error('❌ Connection error:', err);
    process.exit(1);
  });
  
  setTimeout(() => {
    console.error('⌛ Test timeout!');
    process.exit(1);
  }, 20000);
}

runRenderingTest();