const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });
const PORT = process.env.PORT || 3000;
const rooms = new Map();

app.use(express.static('public'));
app.get('/health', (_req, res) => res.json({ ok: true }));

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({ length: 6 }, () => chars[crypto.randomInt(chars.length)]).join(''); }
  while (rooms.has(code));
  return code;
}
function safeProfile(profile = {}) {
  const name = String(profile.name || 'Гость').trim().slice(0, 24) || 'Гость';
  let avatar = typeof profile.avatar === 'string' ? profile.avatar : '';
  if (!/^data:image\/(png|jpeg|jpg|webp|gif);base64,/.test(avatar)) avatar = '';
  if (avatar.length > 2_100_000) avatar = '';
  return { name, avatar };
}
function publicMembers(room) {
  return [...room.members.values()].map(m => ({ id: m.id, name: m.name, avatar: m.avatar, muted: m.muted }));
}

io.on('connection', socket => {
  socket.on('room:create', (profile, cb) => {
    const code = makeCode();
    rooms.set(code, { code, members: new Map(), createdAt: Date.now() });
    joinRoom(socket, code, profile, cb);
  });
  socket.on('room:join', ({ code, profile } = {}, cb) => {
    joinRoom(socket, String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6), profile, cb);
  });
  function joinRoom(sock, code, profile, cb) {
    const room = rooms.get(code);
    if (!room) return typeof cb === 'function' && cb({ ok: false, error: 'Комната не найдена. Проверь код или создай новую.' });
    if (room.members.size >= 12) return typeof cb === 'function' && cb({ ok: false, error: 'В комнате уже 12 участников.' });
    if ([...room.members.values()].some(m => m.id === sock.id)) return;
    const p = safeProfile(profile);
    const member = { id: sock.id, ...p, muted: false };
    room.members.set(sock.id, member);
    sock.join(code);
    sock.data.roomCode = code;
    sock.data.profile = p;
    sock.emit('room:state', { code, selfId: sock.id, members: publicMembers(room) });
    sock.to(code).emit('member:joined', member);
    io.to(code).emit('room:members', publicMembers(room));
    if (typeof cb === 'function') cb({ ok: true, code });
  }
  socket.on('room:leave', () => leaveRoom(socket));
  socket.on('disconnect', () => leaveRoom(socket));
  function leaveRoom(sock) {
    const code = sock.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (room) {
      room.members.delete(sock.id);
      sock.to(code).emit('member:left', { id: sock.id });
      if (!room.members.size) rooms.delete(code);
      else io.to(code).emit('room:members', publicMembers(room));
    }
    sock.leave(code);
    delete sock.data.roomCode;
  }

  socket.on('profile:update', profile => {
  const code = socket.data.roomCode;
  const room = rooms.get(code);
  const member = room?.members.get(socket.id);

  if (!member) return;

  const updated = safeProfile(profile);
  member.name = updated.name;
  member.avatar = updated.avatar;

  socket.data.profile = updated;
  io.to(code).emit('room:members', publicMembers(room));
});

  socket.on('member:mute', muted => {
    const code = socket.data.roomCode, room = rooms.get(code), member = room?.members.get(socket.id);
    if (!member) return;
    member.muted = !!muted;
    io.to(code).emit('room:members', publicMembers(room));
  });
  socket.on('signal', ({ to, description, candidate } = {}) => {
    if (!to || !socket.data.roomCode) return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomCode !== socket.data.roomCode) return;
    target.emit('signal', { from: socket.id, description, candidate });
  });
  socket.on('chat:send', raw => {
    const code = socket.data.roomCode, room = rooms.get(code), member = room?.members.get(socket.id);
    if (!member || typeof raw !== 'string') return;
    const message = raw.trim().slice(0, 1500);
    if (!message) return;
    io.to(code).emit('chat:message', { id: crypto.randomUUID(), memberId: socket.id, name: member.name, avatar: member.avatar, text: message, at: Date.now() });
  });
});

server.listen(PORT, '0.0.0.0', () => console.log(`Friend Room running on http://localhost:${PORT}`));
