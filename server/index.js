
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const mongoUrl = 'mongodb://localhost:27017';
const dbName = 'chatApp';
let db;

// Connect to MongoDB
async function connectToMongoDB() {
  const client = new MongoClient(mongoUrl, { useUnifiedTopology: true });
  await client.connect();
  db = client.db(dbName);
  console.log(`Connected to database: ${dbName}`);
}

// Function to send chat history to a user
async function sendChatHistory(username, ws) {
  try {
    const chatHistory = await db.collection('messages')
      .find({ $or:[{to:username},{from:username}] })
      .sort({ timestamp: 1 })
      .toArray();


    console.log(`Chat history for ${username}:`, chatHistory);

    for (const message of chatHistory) {
      ws.send(JSON.stringify({ type: 'message', user: message.from, message: message.text, timestamp: message.timestamp }));
    }

    await db.collection('messages')
      .updateMany({ to: username, delivered: false }, { $set: { delivered: true } });

    console.log(`Marked messages as delivered for ${username}`);
  } catch (error) {
    console.error(`Error sending chat history for ${username}:`, error);
  }
}

// Function to save message to MongoDB
async function saveMessage(users, fromUser, messageText) {
  console.log("Saving message from user:", fromUser);
  console.log("Current users:", Array.from(users.values()));

  const timestamp = new Date();
  const recipients = Array.from(users.values()).filter(user => user !== fromUser);

  console.log("Recipients:", recipients);
  for (const recipient of recipients) {
    await db.collection('messages').insertOne({ from: fromUser, to: recipient, text: messageText, delivered: true, timestamp });
    console.log(`Message from ${fromUser} to ${recipient} saved.`);
  }

  // Store the message for offline users
  const offlineUsers = await db.collection('users').find({ username: { $nin: recipients } }).toArray();
  for (const offlineUser of offlineUsers) {
    if(fromUser!==offlineUser.username){
    await db.collection('messages').insertOne({ from: fromUser, to: offlineUser.username, text: messageText, delivered: false, timestamp });
    console.log(`Message from ${fromUser} to offline user ${offlineUser.username} saved.`);
    }
  }
}

// Start WebSocket server
async function startServer() {
  app.use(express.static('public'));

  let users = new Map();

  wss.on('connection', (ws) => {
    console.log('A user connected');

    ws.on('message', async (message) => {
      const data = JSON.parse(message);
      console.log('Received data:', data);

      switch (data.type) {
        case 'join':
          if (data.username && typeof data.username === 'string' && data.username.trim() !== '') {
            users.set(ws, data.username);
            console.log('User joined:', data.username);

            await sendChatHistory(data.username, ws);
            broadcast({ type: 'userList', users: Array.from(users.values()) });
            broadcast({ type: 'userStatus', username: data.username, status: 'online' });

            // Add the user to the database if not already present
            await db.collection('users').updateOne({ username: data.username }, { $set: { username: data.username } }, { upsert: true });
          } else {
            console.error('Invalid username received:', data.username);
          }
          break;
        case 'message':
          const username = users.get(ws);
          if (username) {
            console.log('Message from user:', username, 'Message:', data.message);
            await saveMessage(users, username, data.message);
            broadcast({ type: 'message', user: username, message: data.message, timestamp: new Date() });
          } else {
            console.error('User not found for websocket:', ws);
          }
          break;
        case 'disconnect':
          const disconnectedUser = users.get(ws);
          if (disconnectedUser) {
            console.log('User disconnected:', disconnectedUser);
            users.delete(ws);
            broadcast({ type: 'userList', users: Array.from(users.values()) });
            broadcast({ type: 'userStatus', username: disconnectedUser, status: 'offline' });
          } else {
            console.error('Disconnected user not found in users map');
          }
          break;
        default:
          console.error('Unknown message type received:', data.type);
      }
    });

    ws.on('close', () => {
      const username = users.get(ws);
      if (username) {
        console.log('User disconnected:', username);
        users.delete(ws);
        broadcast({ type: 'userList', users: Array.from(users.values()) });
        broadcast({ type: 'userStatus', username: username, status: 'offline' });
      } else {
        console.error('Disconnected user not found in users map');
      }
    });
  });

  function broadcast(data) {
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  }

  server.listen(3000, function () {
    console.log('Server is listening on port 3000');
  });
}

// Connect to MongoDB and start WebSocket server
connectToMongoDB()
  .then(startServer)
  .catch(err => {
    console.error('Failed to connect to MongoDB', err);
    process.exit(1);
  });
