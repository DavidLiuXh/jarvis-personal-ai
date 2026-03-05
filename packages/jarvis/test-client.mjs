import WebSocket from 'ws';

async function runTest() {
  console.log('Connecting to Jarvis...');
  const ws = new WebSocket('ws://localhost:3000');

  ws.on('open', () => {
    console.log('Connected! Sending test message...');
    ws.send(JSON.stringify({
      type: 'chat',
      sessionId: 'test-session-123',
      payload: 'Hello, are you there?'
    }));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    console.log('Received:', msg.type);
    if (msg.type === 'error') {
      console.error('SERVER ERROR:', msg.message);
      process.exit(1);
    } else if (msg.type === 'done') {
      console.log('Test successful!');
      process.exit(0);
    }
  });

  ws.on('error', (err) => {
    console.error('Connection error:', err);
    process.exit(1);
  });
  
  setTimeout(() => {
    console.error('Test timeout!');
    process.exit(1);
  }, 10000);
}

runTest();