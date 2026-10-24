const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static('public'));

let waitingUser = null;
let onlineUsers = 0;

// Log function jo chats.txt me save karega
function saveLog(text) {
  const logLine = `[${new Date().toISOString()}] ${text}\n`;
  fs.appendFile(path.join(__dirname, 'chats.txt'), logLine, (err) => {
    if (err) console.error("Log error:", err);
  });
}

io.on('connection', (socket) => {
  onlineUsers++;
  io.emit('online_count', onlineUsers);
  socket.partner = null;

  socket.on('find_partner', () => {
    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      socket.partner = waitingUser;
      waitingUser.partner = socket;

      saveLog(`SESSION START: User ${socket.id} paired with ${waitingUser.id}`);

      socket.emit('chat_start', 'You are now connected with a random stranger. Say hi!');
      waitingUser.emit('chat_start', 'You are now connected with a random stranger. Say hi!');

      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit('waiting', 'Looking for someone to chat with...');
    }
  });

  socket.on('send_message', (msg) => {
    // Message save karna terminal logs aur text file me
    saveLog(`CHAT [From ${socket.id}]: ${msg}`);
    console.log(`[MSG] ${socket.id}: ${msg}`);

    if (socket.partner) {
      socket.partner.emit('receive_message', msg);
    }
  });

  socket.on('typing', (status) => {
    if (socket.partner) {
      socket.partner.emit('stranger_typing', status);
    }
  });

  const handleLeave = () => {
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }
    if (socket.partner) {
      saveLog(`SESSION END: User ${socket.id} left`);
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }
  };

  socket.on('disconnect', () => {
    onlineUsers = Math.max(0, onlineUsers - 1);
    io.emit('online_count', onlineUsers);
    handleLeave();
  });

  socket.on('leave_chat', handleLeave);
});

// Admin Route: browser me direct /view-logs khol kar chat dekhne ke liye
app.get('/view-logs', (req, res) => {
  const filePath = path.join(__dirname, 'chats.txt');
  if (fs.existsSync(filePath)) {
    res.sendFile(filePath);
  } else {
    res.send('Abhi tak koi chat save nahi hui hai.');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
