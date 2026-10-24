const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// 5MB tak ki image send allow karne ke liye maxHttpBufferSize badhaya
const io = new Server(server, {
  maxHttpBufferSize: 5e6 // 5 MB
});

app.use(express.static('public'));

let waitingUser = null;

function saveLog(text) {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const logLine = `[${time}] ${text}\n`;
  fs.appendFile(path.join(__dirname, 'chats.txt'), logLine, (err) => {
    if (err) console.error("Log error:", err);
  });
}

function formatUser(socket) {
  if (!socket || !socket.profile) return "Anonymous";
  const name = socket.profile.name || "Anon";
  const age = socket.profile.age ? `${socket.profile.age}y` : "NoAge";
  const fantasy = socket.profile.fantasy ? `[Fantasy: ${socket.profile.fantasy}]` : "";
  return `${name}(${age}) ${fantasy}`.trim();
}

io.on('connection', (socket) => {
  socket.partner = null;
  socket.profile = null;
  socket.currentRoom = null;

  socket.on('set_profile', (profileData) => {
    socket.profile = profileData;
  });

  // 1-on-1 Matching
  socket.on('find_partner', (userProfile) => {
    if (userProfile) socket.profile = userProfile;

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }

    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      socket.partner = waitingUser;
      waitingUser.partner = socket;

      saveLog(`--------------------------------------------------`);
      saveLog(`CONNECTED: [${formatUser(socket)}] <---> [${formatUser(waitingUser)}]`);
      saveLog(`--------------------------------------------------`);

      const socketShare = socket.profile && socket.profile.shareInfo ? {
        name: socket.profile.name || 'Anonymous',
        age: socket.profile.age || '',
        fantasy: socket.profile.fantasy || ''
      } : null;

      const waitingShare = waitingUser.profile && waitingUser.profile.shareInfo ? {
        name: waitingUser.profile.name || 'Anonymous',
        age: waitingUser.profile.age || '',
        fantasy: waitingUser.profile.fantasy || ''
      } : null;

      socket.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: waitingShare
      });

      waitingUser.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: socketShare
      });

      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit('waiting', 'Looking for someone to chat with...');
    }
  });

  // Group Handlers
  socket.on('join_group', (data) => {
    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
    }

    const roomId = data.roomId;
    const groupName = data.groupName || roomId;
    socket.currentRoom = roomId;
    socket.join(roomId);

    if (data.profile) socket.profile = data.profile;

    const senderName = (socket.profile && socket.profile.name) ? socket.profile.name : 'A member';
    saveLog(`[GROUP: ${groupName}] ${senderName} joined room.`);

    socket.emit('group_joined', { roomId, groupName });
    socket.to(roomId).emit('group_system_msg', `${senderName} joined the group!`);
  });

  // Text Message
  socket.on('send_message', (msg) => {
    const sender = formatUser(socket);
    const displayName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Stranger';

    if (socket.currentRoom) {
      saveLog(`[GROUP: ${socket.currentRoom}] ${sender}: ${msg}`);
      socket.to(socket.currentRoom).emit('receive_group_message', {
        sender: displayName,
        text: msg
      });
    } else if (socket.partner) {
      saveLog(`1-ON-1: ${sender}: ${msg}`);
      socket.partner.emit('receive_message', msg);
    }
  });

  // Image Send Handler
  socket.on('send_image', (imageData) => {
    const sender = formatUser(socket);
    const displayName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Stranger';

    if (socket.currentRoom) {
      saveLog(`[GROUP: ${socket.currentRoom}] ${sender} sent an image`);
      socket.to(socket.currentRoom).emit('receive_group_image', {
        sender: displayName,
        image: imageData
      });
    } else if (socket.partner) {
      saveLog(`1-ON-1: ${sender} sent an image`);
      socket.partner.emit('receive_image', imageData);
    }
  });

  socket.on('typing', (status) => {
    if (socket.currentRoom) {
      const displayName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Someone';
      socket.to(socket.currentRoom).emit('group_typing', { sender: displayName, status });
    } else if (socket.partner) {
      socket.partner.emit('stranger_typing', status);
    }
  });

  const handleLeave = () => {
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }
    if (socket.partner) {
      saveLog(`DISCONNECTED: [${formatUser(socket)}] left.`);
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }
    if (socket.currentRoom) {
      const senderName = (socket.profile && socket.profile.name) ? socket.profile.name : 'A member';
      socket.to(socket.currentRoom).emit('group_system_msg', `${senderName} left the group.`);
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }
  };

  socket.on('disconnect', handleLeave);
  socket.on('leave_chat', handleLeave);
});

app.get('/view-logs', (req, res) => {
  const filePath = path.join(__dirname, 'chats.txt');
  if (fs.existsSync(filePath)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.sendFile(filePath);
  } else {
    res.send('Abhi tak koi chat save nahi hui hai.');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
