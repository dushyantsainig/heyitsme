const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

// Cloudflare / Reverse Proxy se real user IP read karne ke liye
app.set('trust proxy', true);

const io = new Server(server, {
  maxHttpBufferSize: 5e6 // 5 MB image limit
});

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.static('public'));

let waitingUser = null;

function saveLog(text) {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const logLine = `<p style="margin: 4px 0;">[${time}] ${text}</p>\n`;
  fs.appendFile(path.join(__dirname, 'chats.html'), logLine, (err) => {
    if (err) console.error("Log error:", err);
  });
}

function getClientIp(socket) {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (forwarded) return forwarded.split(',')[0].trim();
  return socket.handshake.address || "Unknown IP";
}

function formatUser(socket) {
  if (!socket) return "Unknown";
  const ip = getClientIp(socket);
  const name = (socket.profile && socket.profile.name) ? socket.profile.name : "Anon";
  const age = (socket.profile && socket.profile.age) ? `${socket.profile.age}y` : "NoAge";
  const fantasy = (socket.profile && socket.profile.fantasy) ? `[Topic: ${socket.profile.fantasy}]` : "";
  return `${name}(${age}) [IP: ${ip}] ${fantasy}`.trim();
}

io.on('connection', (socket) => {
  socket.partner = null;
  socket.profile = null;
  socket.currentRoom = null;
  socket.inPersonalDM = false;

  socket.on('set_profile', (profileData) => {
    socket.profile = profileData;
  });

  // 1-on-1 Matching
  socket.on('find_partner', (userProfile) => {
    if (userProfile) socket.profile = userProfile;
    socket.inPersonalDM = false;

    if (socket.currentRoom) {
      socket.leave(socket.currentRoom);
      socket.currentRoom = null;
    }

    if (socket.partner) {
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner.inPersonalDM = false;
      socket.partner = null;
    }

    if (waitingUser && waitingUser.id !== socket.id) {
      socket.partner = waitingUser;
      waitingUser.partner = socket;

      saveLog(`<hr><b>CONNECTED:</b> [${formatUser(socket)}] &lt;---&gt; [${formatUser(waitingUser)}]<hr>`);

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
    socket.inPersonalDM = false;
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
    saveLog(`<b>[GROUP: ${groupName}]</b> ${senderName} [IP: ${getClientIp(socket)}] joined.`);

    socket.emit('group_joined', { roomId, groupName });
    socket.to(roomId).emit('group_system_msg', `${senderName} joined the group!`);
  });

  // DM Request System
  socket.on('request_dm', () => {
    if (socket.partner && !socket.inPersonalDM) {
      const senderName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Stranger';
      socket.partner.emit('receive_dm_request', { senderName });
    }
  });

  socket.on('respond_dm_request', (accepted) => {
    if (socket.partner) {
      if (accepted) {
        socket.inPersonalDM = true;
        socket.partner.inPersonalDM = true;

        saveLog(`<b>[DM STARTED]:</b> [${formatUser(socket)}] & [${formatUser(socket.partner)}]`);

        socket.emit('dm_status_update', { inDM: true, msg: 'DM Request Accepted! You are now in Personal DM. Photo sharing is now unlocked! 📸' });
        socket.partner.emit('dm_status_update', { inDM: true, msg: 'DM Request Accepted! You are now in Personal DM. Photo sharing is now unlocked! 📸' });
      } else {
        socket.partner.emit('dm_request_declined');
      }
    }
  });

  // Report & Abuse Logging System
  socket.on('report_partner', (reason) => {
    if (socket.partner) {
      const reportedUser = socket.partner;
      const reportLog = `<span style="background:#dc2626; color:white; padding:3px 8px; border-radius:4px; font-weight:bold;">🚩 ABUSE REPORT FILED</span>: Reporter [${formatUser(socket)}] reported [${formatUser(reportedUser)}]. Reason: "${reason || 'Unspecified inappropriate behavior'}"`;
      
      saveLog(reportLog);
      console.warn(`[INCIDENT REPORT]: ${reportLog}`);

      // Alert both and disconnect
      reportedUser.emit('partner_disconnected', 'You were reported for violating platform terms and have been disconnected.');
      socket.emit('report_confirmed');

      reportedUser.partner = null;
      reportedUser.inPersonalDM = false;
      socket.partner = null;
      socket.inPersonalDM = false;
    }
  });

  // Text Message Handle
  socket.on('send_message', (msg) => {
    const sender = formatUser(socket);
    const displayName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Stranger';

    if (socket.currentRoom) {
      saveLog(`<b>[GROUP: ${socket.currentRoom}] ${sender}:</b> ${msg}`);
      socket.to(socket.currentRoom).emit('receive_group_message', {
        sender: displayName,
        text: msg
      });
    } else if (socket.partner) {
      const tag = socket.inPersonalDM ? 'PERSONAL DM' : '1-ON-1 MAIN';
      saveLog(`<b>${tag} [${sender}]:</b> ${msg}`);
      socket.partner.emit('receive_message', msg);
    }
  });

  // Image Upload Handle
  socket.on('send_image', (payload) => {
    if (!socket.inPersonalDM) {
      socket.emit('system_alert', 'Photos can only be shared inside Personal DM!');
      return;
    }

    const base64Data = payload.image;
    const viewOnce = !!payload.viewOnce;
    const sender = formatUser(socket);
    const displayName = (socket.profile && socket.profile.name) ? socket.profile.name : 'Stranger';

    const matches = base64Data.match(/^data:image\/([A-Za-z-+\/]+);base64,(.+)$/);
    if (matches && matches.length === 3) {
      const ext = matches[1].replace('jpeg', 'jpg');
      const base64Content = matches[2];
      const fileName = `img_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
      const filePath = path.join(uploadsDir, fileName);

      fs.writeFile(filePath, base64Content, 'base64', (err) => {
        if (!err) {
          const imgTag = `<br><a href="/uploads/${fileName}" target="_blank"><img src="/uploads/${fileName}" style="max-width:180px; max-height:180px; border-radius:8px; margin:5px 0; border:1px solid #444;" /></a> ${viewOnce ? '<b>[VIEW ONCE]</b>' : ''}`;
          saveLog(`<b>PERSONAL DM [${sender}] sent photo:</b> ${imgTag}`);
        }
      });
    }

    const outgoingData = {
      sender: displayName,
      image: base64Data,
      viewOnce: viewOnce,
      msgId: 'msg_' + Math.random().toString(36).substring(2, 9)
    };

    if (socket.partner) {
      socket.partner.emit('receive_image', outgoingData);
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
      saveLog(`<i>DISCONNECTED: [${formatUser(socket)}] left.</i>`);
      socket.partner.emit('partner_disconnected');
      socket.partner.partner = null;
      socket.partner.inPersonalDM = false;
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
  const filePath = path.join(__dirname, 'chats.html');
  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <title>Live Chat & Security Logs</title>
        <style>
          body { background: #0c0d11; color: #eee; font-family: sans-serif; padding: 20px; font-size: 13.5px; line-height: 1.5; }
          hr { border: 0; border-top: 1px solid #222; margin: 10px 0; }
          b { color: #38bdf8; }
          a { color: #f472b6; text-decoration: none; }
        </style>
      </head>
      <body>
        <h2 style="color:#f87171;">Audit Logs & Abuse Tracking</h2>
        <p style="color:#94a3b8; font-size:12px;">Timestamps, User IPs, and Session Records</p>
        <div id="logs">${content}</div>
      </body>
      </html>
    `);
  } else {
    res.send('Abhi tak koi chat ya photo share nahi hui hai.');
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
