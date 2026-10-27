const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);

app.set('trust proxy', true);

// Allow up to 30MB buffer for incoming video and photo data
const io = new Server(server, {
  maxHttpBufferSize: 30e6
});

const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

app.use(express.static(path.join(__dirname, 'public')));

let waitingUser = null;
const activeGroups = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function saveLog(htmlSnippet) {
  const time = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  const entry = `<p style="margin: 4px 0;">[${time}] ${htmlSnippet}</p>\n`;
  fs.appendFile(path.join(__dirname, 'chats.html'), entry, (err) => {
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
  const name = escapeHtml((socket.profile && socket.profile.name) ? socket.profile.name : "Anon");
  const age = (socket.profile && socket.profile.age) ? `${escapeHtml(socket.profile.age)}y` : "NoAge";
  const fantasy = (socket.profile && socket.profile.fantasy) ? ` [Topic: ${escapeHtml(socket.profile.fantasy)}]` : "";
  return `${name}(${age}) [IP: ${ip}]${fantasy}`;
}

function broadcastGroupList() {
  io.emit('group_list_update', Array.from(activeGroups.values()));
}

function handleLeaveRoom(socket) {
  if (socket.currentRoom) {
    const rId = socket.currentRoom;
    const senderName = escapeHtml((socket.profile && socket.profile.name) || 'A member');
    socket.to(rId).emit('group_system_msg', `${senderName} left the group.`);
    socket.leave(rId);
    socket.currentRoom = null;

    if (activeGroups.has(rId)) {
      const g = activeGroups.get(rId);
      g.memberCount -= 1;
      if (g.memberCount <= 0) {
        activeGroups.delete(rId);
      }
      broadcastGroupList();
    }
  }
}

function disconnectPartner(socket) {
  if (socket.partner) {
    socket.partner.emit('partner_disconnected');
    socket.partner.partner = null;
    socket.partner.inPersonalDM = false;
    socket.partner = null;
  }
  socket.inPersonalDM = false;
}

io.on('connection', (socket) => {
  socket.partner = null;
  socket.profile = null;
  socket.currentRoom = null;
  socket.inPersonalDM = false;

  socket.emit('group_list_update', Array.from(activeGroups.values()));

  socket.on('set_profile', (profileData) => {
    if (typeof profileData === 'object' && profileData !== null) {
      socket.profile = {
        name: String(profileData.name || '').slice(0, 30),
        age: String(profileData.age || '').slice(0, 3),
        fantasy: String(profileData.fantasy || '').slice(0, 150),
        shareInfo: Boolean(profileData.shareInfo)
      };
    }
  });

  socket.on('get_groups', () => {
    socket.emit('group_list_update', Array.from(activeGroups.values()));
  });

  socket.on('find_partner', (userProfile) => {
    if (userProfile) socket.profile = userProfile;
    disconnectPartner(socket);
    handleLeaveRoom(socket);

    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }

    if (waitingUser && waitingUser.connected) {
      const partner = waitingUser;
      waitingUser = null;

      socket.partner = partner;
      partner.partner = socket;

      saveLog(`<hr><b>CONNECTED:</b> [${formatUser(socket)}] &lt;---&gt; [${formatUser(partner)}]<hr>`);

      const socketShare = socket.profile && socket.profile.shareInfo ? socket.profile : null;
      const partnerShare = partner.profile && partner.profile.shareInfo ? partner.profile : null;

      socket.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: partnerShare
      });

      partner.emit('chat_start', {
        msg: 'You are now connected with a partner. Say hi!',
        partnerProfile: socketShare
      });
    } else {
      waitingUser = socket;
      socket.emit('waiting', 'Looking for someone to chat with...');
    }
  });

  socket.on('join_group', (data) => {
    if (!data || !data.roomId) return;

    disconnectPartner(socket);
    if (waitingUser && waitingUser.id === socket.id) waitingUser = null;
    handleLeaveRoom(socket);

    const roomId = String(data.roomId).slice(0, 40);
    const groupName = escapeHtml(String(data.groupName || roomId).slice(0, 50));

    socket.currentRoom = roomId;
    socket.join(roomId);

    if (data.profile) socket.profile = data.profile;

    if (!activeGroups.has(roomId)) {
      activeGroups.set(roomId, { roomId, groupName, memberCount: 1 });
    } else {
      activeGroups.get(roomId).memberCount += 1;
    }
    broadcastGroupList();

    const senderName = escapeHtml((socket.profile && socket.profile.name) || 'A member');
    saveLog(`<b>[GROUP: ${groupName}]</b> ${senderName} [IP: ${getClientIp(socket)}] joined.`);

    socket.emit('group_joined', { roomId, groupName });
    socket.to(roomId).emit('group_system_msg', `${senderName} joined the group!`);
  });

  socket.on('request_dm', () => {
    if (socket.partner && !socket.inPersonalDM) {
      const senderName = escapeHtml((socket.profile && socket.profile.name) || 'Stranger');
      socket.partner.emit('receive_dm_request', { senderName });
    }
  });

  socket.on('respond_dm_request', (accepted) => {
    if (socket.partner) {
      if (accepted) {
        socket.inPersonalDM = true;
        socket.partner.inPersonalDM = true;
        saveLog(`<b>[DM STARTED]:</b> [${formatUser(socket)}] & [${formatUser(socket.partner)}]`);

        const dmMsg = { inDM: true, msg: 'DM Accepted! Photo & Video sharing is unlocked. 📸 📹' };
        socket.emit('dm_status_update', dmMsg);
        socket.partner.emit('dm_status_update', dmMsg);
      } else {
        socket.partner.emit('dm_request_declined');
      }
    }
  });

  socket.on('report_partner', (reason) => {
    if (socket.partner) {
      const reportedUser = socket.partner;
      const cleanReason = escapeHtml(String(reason || 'Unspecified').slice(0, 200));
      const log = `<span style="background:#dc2626; color:white; padding:2px 6px; border-radius:4px;">🚩 REPORT</span>: [${formatUser(socket)}] reported [${formatUser(reportedUser)}]. Reason: "${cleanReason}"`;

      saveLog(log);
      reportedUser.emit('partner_disconnected', 'You were reported for violating platform terms and disconnected.');
      socket.emit('report_confirmed');

      disconnectPartner(socket);
    }
  });

  socket.on('send_message', (msg) => {
    if (typeof msg !== 'string' || !msg.trim()) return;
    const cleanMsg = escapeHtml(msg.trim().slice(0, 2000));
    const sender = formatUser(socket);
    const displayName = escapeHtml((socket.profile && socket.profile.name) || 'Stranger');

    if (socket.currentRoom) {
      const g = activeGroups.get(socket.currentRoom);
      const gName = g ? g.groupName : socket.currentRoom;
      saveLog(`<b>[GROUP: ${gName}] ${sender}:</b> ${cleanMsg}`);
      socket.to(socket.currentRoom).emit('receive_group_message', {
        sender: displayName,
        text: cleanMsg
      });
    } else if (socket.partner) {
      const tag = socket.inPersonalDM ? 'PERSONAL DM' : '1-ON-1 MAIN';
      saveLog(`<b>${tag} [${sender}]:</b> ${cleanMsg}`);
      socket.partner.emit('receive_message', cleanMsg);
    }
  });

  // Media Handler (Both Video & Image)
  socket.on('send_media', (payload) => {
    if (!socket.inPersonalDM || !payload || typeof payload.data !== 'string') {
      socket.emit('system_alert', 'Photos and videos are restricted to Personal DM.');
      return;
    }

    const viewOnce = Boolean(payload.viewOnce);
    const mediaType = payload.mediaType === 'video' ? 'video' : 'image';
    const sender = formatUser(socket);
    const displayName = escapeHtml((socket.profile && socket.profile.name) || 'Stranger');

    // Matches image MIME types or video MIME types (mp4, webm, quicktime)
    const matches = payload.data.match(/^data:(image\/(?:png|jpeg|jpg|webp)|video\/(?:mp4|webm|quicktime));base64,(.+)$/i);

    if (matches && matches.length === 3) {
      const mime = matches[1].toLowerCase();
      let ext = 'mp4';
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
      else if (mime.includes('webm')) ext = 'webm';
      else if (mime.includes('quicktime')) ext = 'mov';

      const base64Content = matches[2];
      const fileName = `${mediaType}_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`;
      const filePath = path.join(uploadsDir, fileName);

      fs.writeFile(filePath, base64Content, 'base64', (err) => {
        if (!err) {
          const previewHtml = mediaType === 'video'
            ? `<br><video src="/uploads/${fileName}" controls style="max-width:200px; max-height:200px; border-radius:8px;"></video> ${viewOnce ? '<b>[VIEW ONCE VIDEO]</b>' : ''}`
            : `<br><a href="/uploads/${fileName}" target="_blank"><img src="/uploads/${fileName}" style="max-width:180px; max-height:180px; border-radius:8px;" /></a> ${viewOnce ? '<b>[VIEW ONCE IMAGE]</b>' : ''}`;

          saveLog(`<b>PERSONAL DM [${sender}] sent ${mediaType}:</b> ${previewHtml}`);

          // Delete view-once media from disk after 90 seconds
          if (viewOnce) {
            setTimeout(() => {
              fs.unlink(filePath, () => {});
            }, 90000);
          }
        }
      });
    }

    if (socket.partner) {
      socket.partner.emit('receive_media', {
        sender: displayName,
        data: payload.data,
        mediaType: mediaType,
        viewOnce: viewOnce,
        msgId: 'msg_' + Math.random().toString(36).substring(2, 9)
      });
    }
  });

  socket.on('typing', (status) => {
    const isTyping = Boolean(status);
    if (socket.currentRoom) {
      const displayName = escapeHtml((socket.profile && socket.profile.name) || 'Someone');
      socket.to(socket.currentRoom).emit('group_typing', { sender: displayName, status: isTyping });
    } else if (socket.partner) {
      socket.partner.emit('stranger_typing', isTyping);
    }
  });

  const cleanExit = () => {
    if (waitingUser && waitingUser.id === socket.id) {
      waitingUser = null;
    }
    if (socket.partner) {
      saveLog(`<i>DISCONNECTED: [${formatUser(socket)}] left.</i>`);
    }
    disconnectPartner(socket);
    handleLeaveRoom(socket);
  };

  socket.on('disconnect', cleanExit);
  socket.on('leave_chat', cleanExit);
});

app.get('/view-logs', (req, res) => {
  const filePath = path.join(__dirname, 'chats.html');
  if (!fs.existsSync(filePath)) {
    return res.send('No logs available yet.');
  }

  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <title>Audit Logs</title>
      <style>
        body { background: #0c0d11; color: #eee; font-family: monospace; padding: 20px; font-size: 13px; line-height: 1.5; }
        b { color: #38bdf8; }
        a { color: #f472b6; }
      </style>
    </head>
    <body>
      <h2 style="color:#f87171;">Audit Logs & Abuse Tracking</h2>
  `);

  const stream = fs.createReadStream(filePath);
  stream.pipe(res, { end: false });
  stream.on('end', () => {
    res.end('</body></html>');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
