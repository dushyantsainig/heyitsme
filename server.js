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

function saveLog(text) {
  const logLine = `[${new Date().toISOString()}] ${text}\n`;
  fs.appendFile(path.join(__dirname, 'chats.txt'), logLine, (err) => {
    if (err) console.error("Log error:", err);
  });
}

io.on('connection', (socket) => {
  socket.partner = null;
  socket.profile = null;

  // Profile update handler
  socket.on('set_profile', (profileData) => {
    socket.profile = profileData;
  });

  socket.on('find_partner', (userProfile) => {
    if (userProfile) {
      socket.profile = userProfile;
    }

    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      socket.partner = waitingUser;
      waitingUser.partner = socket;

      saveLog(`SESSION START: User ${socket.id} paired with ${waitingUser.id}`);

      // Dono ko ek dusre ki profile bhejna (privacy ke hisab se)
      const socketShareData = socket.profile && socket.profile.shareInfo ? {
        name: socket.profile.name || 'Anonymous',
        age: socket.profile.age || '',
        fantasy: socket.profile.fantasy || ''
      } : null;

      const waitingShareData = waitingUser.profile && waitingUser.profile.shareInfo ? {
        name: waitingUser.profile.name || 'Anonymous',
        age: waitingUser.profile.age || '',
        fantasy: waitingUser.profile.fantasy || ''
      } : null;

      socket.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: waitingShareData
      });

      waitingUser.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: socketShareData
      });

      waitingUser = null;
    } else {
      waitingUser = socket;
      socket.emit('waiting', 'Looking for someone to chat with...');
    }
  });

  socket.on('send_message', (msg) => {
    saveLog(`CHAT [From ${socket.id}]: ${msg}`);
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

  socket.on('disconnect', handleLeave);
  socket.on('leave_chat', handleLeave);
});

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
