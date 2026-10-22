const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { promisify } = require("util");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 3e6 });
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const SESSION_AGE = 365 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
const rooms = new Map();
const store = loadStore();

app.use(express.json({ limit: "5mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use(
  "/noise-suppressor",
  express.static(
    path.join(
      __dirname,
      "node_modules",
      "@sapphi-red",
      "web-noise-suppressor",
      "dist",
    ),
  ),
);
app.get("/health", (_req, res) => res.json({ ok: true }));

function loadStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) return { users: [], sessions: [] };

  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    return {
      users: Array.isArray(data.users) ? data.users : [],
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
    };
  } catch (error) {
    console.error("Не удалось прочитать хранилище аккаунтов:", error);
    throw error;
  }
}

function saveStore() {
  const temporaryFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(store), { mode: 0o600 });
  fs.renameSync(temporaryFile, DATA_FILE);
}

function publicProfile(user) {
  return {
    name: user.name,
    about: user.about,
    avatar: user.avatar,
    cover: user.cover,
    friendId: user.friendId,
  };
}

function publicFriend(user) {
  return { id: user.id, ...publicProfile(user) };
}

function normalizeLogin(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function validFriendId(value) {
  return /^[a-zA-Z0-9_]{3,20}$/.test(value);
}

function validImage(value, maxLength) {
  return (
    typeof value === "string" &&
    value.length <= maxLength &&
    /^data:image\/(png|jpeg|jpg|webp|gif);base64,[a-zA-Z0-9+/]+=*$/.test(value)
  );
}

function getCookie(req, name) {
  const cookie = req.headers.cookie || "";
  const entry = cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : "";
}

function findSessionUser(req) {
  const token = getCookie(req, "friend_room_session");
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = store.sessions.find(
    (entry) =>
      entry.tokenHash === tokenHash && entry.expiresAt > Date.now(),
  );
  return session ? store.users.find((user) => user.id === session.userId) : null;
}

function requireUser(req, res, next) {
  const user = findSessionUser(req);
  if (!user) return res.status(401).json({ error: "Войди в аккаунт." });
  req.user = user;
  next();
}

function issueSession(user, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  store.sessions = store.sessions.filter(
    (entry) => entry.expiresAt > Date.now(),
  );
  store.sessions.push({
    userId: user.id,
    tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
    expiresAt: Date.now() + SESSION_AGE,
  });
  saveStore();
  res.cookie("friend_room_session", token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_AGE,
    path: "/",
  });
}

function handleError(res, error) {
  console.error("Ошибка API:", error);
  res.status(500).json({ error: "Внутренняя ошибка сервера." });
}

app.post("/api/register", async (req, res) => {
  try {
    const { login, password, name } = req.body || {};
    const normalizedLogin = normalizeLogin(login);
    const displayName = String(name || "").trim();
    if (!/^[a-z0-9_]{3,24}$/.test(normalizedLogin)) {
      return res.status(400).json({
        error: "Логин: от 3 до 24 символов, латинские буквы, цифры и _.",
      });
    }
    if (typeof password !== "string" || password.length < 8 || password.length > 128) {
      return res.status(400).json({ error: "Пароль должен быть длиной от 8 до 128 символов." });
    }
    if (!displayName || displayName.length > 24) {
      return res.status(400).json({ error: "Имя должно быть длиной от 1 до 24 символов." });
    }
    if (store.users.some((user) => user.login === normalizedLogin)) {
      return res.status(409).json({ error: "Этот логин уже занят." });
    }

    let friendId;
    do {
      friendId = `p${crypto.randomBytes(4).toString("hex")}`;
    } while (store.users.some((user) => user.friendId === friendId));
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await scrypt(password, salt, 64);
    const user = {
      id: crypto.randomUUID(),
      login: normalizedLogin,
      passwordSalt: salt,
      passwordHash: passwordHash.toString("hex"),
      name: displayName,
      about: "",
      avatar: "",
      cover: "",
      friendId,
      friends: [],
      createdAt: Date.now(),
    };
    store.users.push(user);
    issueSession(user, res);
    res.status(201).json({ user: publicFriend(user), friends: [] });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const normalizedLogin = normalizeLogin(req.body?.login);
    const password = req.body?.password;
    const user = store.users.find((entry) => entry.login === normalizedLogin);
    if (!user || typeof password !== "string") {
      return res.status(401).json({ error: "Неверный логин или пароль." });
    }
    const actual = await scrypt(password, user.passwordSalt, 64);
    const expected = Buffer.from(user.passwordHash, "hex");
    if (
      actual.length !== expected.length ||
      !crypto.timingSafeEqual(actual, expected)
    ) {
      return res.status(401).json({ error: "Неверный логин или пароль." });
    }
    issueSession(user, res);
    res.json({
      user: publicFriend(user),
      friends: user.friends
        .map((id) => store.users.find((friend) => friend.id === id))
        .filter(Boolean)
        .map(publicFriend),
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/me", (req, res) => {
  const user = findSessionUser(req);
  if (!user) return res.json({ user: null, friends: [] });
  res.json({
    user: publicFriend(user),
    friends: user.friends
      .map((id) => store.users.find((friend) => friend.id === id))
      .filter(Boolean)
      .map(publicFriend),
  });
});

app.post("/api/logout", requireUser, (req, res) => {
  const token = getCookie(req, "friend_room_session");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  store.sessions = store.sessions.filter(
    (session) => session.tokenHash !== tokenHash,
  );
  saveStore();
  for (const connected of io.sockets.sockets.values()) {
    if (connected.data.userId === req.user.id) connected.disconnect(true);
  }
  res.clearCookie("friend_room_session", { path: "/" });
  res.json({ ok: true });
});

app.put("/api/profile", requireUser, (req, res) => {
  const { name, about, avatar = "", cover = "", friendId } = req.body || {};
  const nextName = String(name || "").trim();
  const nextAbout = String(about || "").trim();
  const nextFriendId = String(friendId || "").trim();
  if (!nextName || nextName.length > 24) {
    return res.status(400).json({ error: "Имя должно быть длиной от 1 до 24 символов." });
  }
  if (nextAbout.length > 200) {
    return res.status(400).json({ error: "Описание не должно превышать 200 символов." });
  }
  if (!validFriendId(nextFriendId)) {
    return res.status(400).json({
      error: "ID: от 3 до 20 символов, латинские буквы, цифры и _.",
    });
  }
  if (
    store.users.some(
      (user) =>
        user.id !== req.user.id &&
        user.friendId.toLowerCase() === nextFriendId.toLowerCase(),
    )
  ) {
    return res.status(409).json({ error: "Этот ID уже занят." });
  }
  if (avatar && !validImage(avatar, 2_100_000)) {
    return res.status(400).json({ error: "Некорректная аватарка или файл слишком большой." });
  }
  if (cover && !validImage(cover, 3_000_000)) {
    return res.status(400).json({ error: "Некорректная шапка профиля или файл слишком большой." });
  }

  Object.assign(req.user, {
    name: nextName,
    about: nextAbout,
    friendId: nextFriendId,
    avatar,
    cover,
  });
  saveStore();
  for (const connected of io.sockets.sockets.values()) {
    if (connected.data.userId !== req.user.id) continue;
    connected.data.profile = publicProfile(req.user);
    const room = rooms.get(connected.data.roomCode);
    if (!room) continue;
    const member = room.members.get(connected.id);
    if (member) Object.assign(member, publicProfile(req.user));
    io.to(room.code).emit("room:members", publicMembers(room));
  }
  res.json({ user: publicFriend(req.user) });
});

app.get("/api/friends", requireUser, (req, res) => {
  res.json({
    friends: req.user.friends
      .map((id) => store.users.find((friend) => friend.id === id))
      .filter(Boolean)
      .map(publicFriend),
  });
});

app.post("/api/friends", requireUser, (req, res) => {
  const friendId = String(req.body?.friendId || "").trim();
  const friend = store.users.find(
    (user) => user.friendId.toLowerCase() === friendId.toLowerCase(),
  );
  if (!friend) return res.status(404).json({ error: "Пользователь с таким ID не найден." });
  if (friend.id === req.user.id) {
    return res.status(400).json({ error: "Нельзя добавить самого себя." });
  }
  if (req.user.friends.includes(friend.id)) {
    return res.status(409).json({ error: "Этот пользователь уже в друзьях." });
  }
  req.user.friends.push(friend.id);
  friend.friends.push(req.user.id);
  saveStore();
  for (const connected of io.sockets.sockets.values()) {
    if (connected.data.userId === friend.id) connected.emit("friends:refresh");
  }
  res.status(201).json({ friend: publicFriend(friend) });
});

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;
  do {
    code = Array.from(
      { length: 6 },
      () => chars[crypto.randomInt(chars.length)],
    ).join("");
  } while (rooms.has(code));
  return code;
}
function publicMembers(room) {
  return [...room.members.values()].map((m) => ({
    id: m.id,
    name: m.name,
    about: m.about,
    avatar: m.avatar,
    cover: m.cover,
    friendId: m.friendId,
    muted: m.muted,
    screenSharing: Boolean(m.screenSharing),
  }));
}

io.on("connection", (socket) => {
  socket.on("room:create", (cb) => {
    const code = makeCode();
    rooms.set(code, { code, members: new Map(), createdAt: Date.now() });
    joinRoom(socket, code, cb);
  });
  socket.on("room:join", (payload, cb) => {
    const { code } = payload && typeof payload === "object" ? payload : {};
    joinRoom(
      socket,
      String(code || "")
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, "")
        .slice(0, 6),
      cb,
    );
  });
  function joinRoom(sock, code, cb) {
    const room = rooms.get(code);
    if (!room)
      return (
        typeof cb === "function" &&
        cb({
          ok: false,
          error: "Комната не найдена. Проверь код или создай новую.",
        })
      );
    const alreadyMember =
      sock.data.roomCode === code && room.members.has(sock.id);
    if (room.members.size >= 12 && !alreadyMember)
      return (
        typeof cb === "function" &&
        cb({ ok: false, error: "В комнате уже 12 участников." })
      );
    if (alreadyMember) {
      if (typeof cb === "function") cb({ ok: true, code });
      return;
    }
    if (sock.data.roomCode) leaveRoom(sock);
    const p = sock.data.profile;
    const member = { id: sock.id, ...p, muted: false, screenSharing: false };
    room.members.set(sock.id, member);
    sock.join(code);
    sock.data.roomCode = code;
    sock.data.profile = p;
    sock.emit("room:state", {
      code,
      selfId: sock.id,
      members: publicMembers(room),
    });
    sock.to(code).emit("member:joined", member);
    io.to(code).emit("room:members", publicMembers(room));
    if (typeof cb === "function") cb({ ok: true, code });
  }
  socket.on("room:leave", () => leaveRoom(socket));
  socket.on("disconnect", () => leaveRoom(socket));
  function leaveRoom(sock) {
    const code = sock.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (room) {
      room.members.delete(sock.id);
      sock.to(code).emit("member:left", { id: sock.id });
      if (!room.members.size) rooms.delete(code);
      else io.to(code).emit("room:members", publicMembers(room));
    }
    sock.leave(code);
    delete sock.data.roomCode;
  }

  socket.on("member:mute", (muted) => {
    const code = socket.data.roomCode,
      room = rooms.get(code),
      member = room?.members.get(socket.id);
    if (!member) return;
    member.muted = !!muted;
    io.to(code).emit("room:members", publicMembers(room));
  });
  socket.on("screen-share:state", (active) => {
    const code = socket.data.roomCode,
      room = rooms.get(code),
      member = room?.members.get(socket.id);
    if (!member) return;
    member.screenSharing = active === true;
    io.to(code).emit("room:members", publicMembers(room));
  });
  socket.on("signal", (payload) => {
    const { to, description, candidate } =
      payload && typeof payload === "object" ? payload : {};
    if (!to || !socket.data.roomCode) return;
    const target = io.sockets.sockets.get(to);
    if (!target || target.data.roomCode !== socket.data.roomCode) return;
    target.emit("signal", { from: socket.id, description, candidate });
  });
  socket.on("chat:send", (raw) => {
    const code = socket.data.roomCode,
      room = rooms.get(code),
      member = room?.members.get(socket.id);
    if (!member || typeof raw !== "string") return;
    const message = raw.trim().slice(0, 1500);
    if (!message) return;
    io.to(code).emit("chat:message", {
      id: crypto.randomUUID(),
      memberId: socket.id,
      name: member.name,
      avatar: member.avatar,
      text: message,
      at: Date.now(),
    });
  });
});

io.use((socket, next) => {
  const token = getCookie(
    { headers: socket.request.headers },
    "friend_room_session",
  );
  if (!token) return next(new Error("Войди в аккаунт."));
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = store.sessions.find(
    (entry) =>
      entry.tokenHash === tokenHash && entry.expiresAt > Date.now(),
  );
  const user = session && store.users.find((entry) => entry.id === session.userId);
  if (!user) return next(new Error("Сессия истекла. Войди снова."));
  socket.data.userId = user.id;
  socket.data.profile = publicProfile(user);
  next();
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`Friend Room running on http://localhost:${PORT}`),
);
