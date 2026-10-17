(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);
  const state = {
    code: null,
    selfId: null,
    members: new Map(),
    peers: new Map(),
    localStream: null,
    muted: false,
    profile: { name: "", avatar: "" },
    pendingAction: null,
    settingsOpen: false,
    chatOpen: false,
    unread: 0,
    micTestStream: null,
    micTestFrame: null,
    micTestContext: null,
    audioEls: new Map(),
    joinedAt: null,
  };
  const rtcConfig = {
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun1.l.google.com:19302" },
    ],
  };

  function show(el, visible = true) {
    el.classList.toggle("hidden", !visible);
  }
  function notice(message) {
    $("homeError").textContent = message;
    show($("homeError"));
  }
  function clearNotice() {
    show($("homeError"), false);
  }
  function escapeText(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  }
  function initials(name) {
    return (name || "?").trim().slice(0, 1).toUpperCase();
  }
  function avatarMarkup(member, cls = "member-avatar") {
    return member.avatar
      ? `<img class="${cls}" src="${member.avatar}" alt="">`
      : `<div class="${cls}">${escapeText(initials(member.name))}</div>`;
  }
  function readProfile() {
    return {
      name:
        ($("displayName").value || $("gateName").value || "Гость")
          .trim()
          .slice(0, 24) || "Гость",
      avatar: state.profile.avatar || "",
    };
  }
  function setAvatarPreview(previewId, avatar) {
    const el = $(previewId);
    if (avatar) {
      el.replaceWith(
        Object.assign(document.createElement("img"), {
          id: previewId,
          className: "avatar-preview",
          src: avatar,
          alt: "Аватарка",
        }),
      );
    } else {
      const old = $(previewId);
      if (old.tagName === "IMG")
        old.replaceWith(
          Object.assign(document.createElement("div"), {
            id: previewId,
            className: "avatar-preview",
            textContent: "✦",
          }),
        );
      else old.textContent = "✦";
    }
  }
  function useAvatarFile(file, previewId) {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp|gif)$/.test(file.type) ||
      file.size > 1_500_000
    ) {
      $("settingsError").textContent =
        "Выбери картинку PNG, JPG, WebP или GIF до 1,5 МБ.";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.profile.avatar = String(reader.result);
      setAvatarPreview(previewId, state.profile.avatar);
      $("settingsError").textContent = "";
    };
    reader.readAsDataURL(file);
  }
  $("avatarFile").addEventListener("change", (e) =>
    useAvatarFile(e.target.files[0], "avatarPreview"),
  );
  $("gateAvatarFile").addEventListener("change", (e) =>
    useAvatarFile(e.target.files[0], "gateAvatarPreview"),
  );

  async function getMedia() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(
        "Нужен современный браузер и защищённое соединение HTTPS (или localhost).",
      );
    }

    const deviceId = $("micSelect").value;

    const audioConstraints = {
      echoCancellation: { ideal: true },
      noiseSuppression: { ideal: true },
      autoGainControl: { ideal: true },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    };

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: audioConstraints,
      video: false,
    });

    const track = stream.getAudioTracks()[0];

    if (track) {
      console.log("Обработка микрофона:", track.getSettings());
    }

    return stream;
  }
  function stopStream(stream) {
    stream?.getTracks().forEach((t) => t.stop());
  }
  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mic = $("micSelect"),
        speaker = $("speakerSelect"),
        micVal = mic.value,
        speakerVal = speaker.value;
      mic.innerHTML = '<option value="">По умолчанию</option>';
      speaker.innerHTML = '<option value="">По умолчанию</option>';
      devices
        .filter((d) => d.kind === "audioinput")
        .forEach((d, i) =>
          mic.add(new Option(d.label || `Микрофон ${i + 1}`, d.deviceId)),
        );
      devices
        .filter((d) => d.kind === "audiooutput")
        .forEach((d, i) =>
          speaker.add(
            new Option(d.label || `Устройство вывода ${i + 1}`, d.deviceId),
          ),
        );
      mic.value = micVal;
      speaker.value = speakerVal;
    } catch (_) {}
  }
  function openSettings() {
    $("displayName").value = state.profile.name || "";
    setAvatarPreview("avatarPreview", state.profile.avatar);
    $("settingsError").textContent = "";
    show($("modalBackdrop"));
    state.settingsOpen = true;
    refreshDevices();
  }
  function closeSettings() {
    show($("modalBackdrop"), false);
    state.settingsOpen = false;
    stopMicTest();
  }
  $("openSettingsHome").onclick = openSettings;
  $("settingsRoom").onclick = openSettings;
  $("closeSettings").onclick = closeSettings;
  $("modalBackdrop").addEventListener("click", (e) => {
    if (e.target === $("modalBackdrop")) closeSettings();
  });
  $("saveSettings").onclick = async () => {
    state.profile = { ...state.profile, ...readProfile() };
    if (state.code) {
      socket.emit("profile:update", state.profile);
    }
    if (state.localStream && $("micSelect").value) {
      try {
        const fresh = await getMedia();
        const old = state.localStream;
        state.localStream = fresh;
        for (const pc of state.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
          if (sender) await sender.replaceTrack(fresh.getAudioTracks()[0]);
        }
        stopStream(old);
      } catch (e) {
        $("settingsError").textContent =
          e.message || "Не удалось переключить микрофон.";
        return;
      }
    }
    if (state.localStream) {
      state.localStream
        .getAudioTracks()
        .forEach((t) => (t.enabled = !state.muted));
    }
    renderMembers();
    closeSettings();
  };
  $("testMic").onclick = async () => {
    stopMicTest();
    try {
      state.micTestStream = await getMedia();
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      state.micTestContext = new AudioContext();
      const source = state.micTestContext.createMediaStreamSource(
          state.micTestStream,
        ),
        analyser = state.micTestContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      $("micStatus").textContent = "Говори — индикатор покажет уровень звука.";
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const n of data) sum += (n - 128) ** 2;
        const rms = Math.sqrt(sum / data.length);
        $("micMeter").style.width = Math.min(100, Math.max(2, rms * 2.2)) + "%";
        state.micTestFrame = requestAnimationFrame(tick);
      };
      tick();
      await refreshDevices();
    } catch (e) {
      $("micStatus").textContent =
        e.name === "NotAllowedError"
          ? "Нет доступа к микрофону. Разреши его в браузере."
          : e.message || "Не удалось включить микрофон.";
    }
  };
  function stopMicTest() {
    if (state.micTestFrame) cancelAnimationFrame(state.micTestFrame);
    state.micTestFrame = null;
    stopStream(state.micTestStream);
    state.micTestStream = null;
    if (state.micTestContext) state.micTestContext.close().catch(() => {});
    state.micTestContext = null;
    $("micMeter").style.width = "0";
  }
  $("micSelect").addEventListener("change", refreshDevices);
  $("speakerSelect").addEventListener("change", async () => {
    const deviceId = $("speakerSelect").value;
    for (const audio of state.audioEls.values())
      if (audio.setSinkId) {
        try {
          await audio.setSinkId(deviceId || "default");
        } catch (_) {}
      }
  });

  function createPeer(id) {
    if (state.peers.has(id)) return state.peers.get(id);
    const pc = new RTCPeerConnection(rtcConfig);
    state.peers.set(id, pc);
    state.localStream
      ?.getTracks()
      .forEach((track) => pc.addTrack(track, state.localStream));
    pc.onicecandidate = (e) => {
      if (e.candidate)
        socket.emit("signal", { to: id, candidate: e.candidate });
    };
    pc.ontrack = (e) => attachAudio(id, e.streams[0]);
    pc.onconnectionstatechange = () => {
      if (
        pc.connectionState === "failed" ||
        pc.connectionState === "disconnected"
      )
        showConnectionIssue(
          "Соединение с одним из участников нестабильно. Попробуйте переподключиться.",
        );
      else if (
        [...state.peers.values()].every((p) =>
          ["connected", "new", "connecting"].includes(p.connectionState),
        )
      )
        hideConnectionIssue();
    };
    return pc;
  }
  async function attachAudio(id, stream) {
    let audio = state.audioEls.get(id);
    if (!audio) {
      audio = document.createElement("audio");
      audio.autoplay = true;
      audio.playsInline = true;
      audio.dataset.member = id;
      audio.style.display = "none";
      document.body.appendChild(audio);
      state.audioEls.set(id, audio);
    }
    audio.srcObject = stream;
    const deviceId = $("speakerSelect").value;
    if (deviceId && audio.setSinkId) {
      try {
        await audio.setSinkId(deviceId);
      } catch (_) {}
    }
    const slider = document.querySelector(`[data-volume="${id}"]`);
    audio.volume = slider ? Number(slider.value) : 1;
    try {
      await audio.play();
    } catch (_) {
      showConnectionIssue(
        "Нажми на страницу, чтобы разрешить воспроизведение звука.",
      );
    }
  }
  async function offerTo(id) {
    const pc = createPeer(id);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit("signal", { to: id, description: pc.localDescription });
  }
  socket.on("signal", async ({ from, description, candidate }) => {
    try {
      const pc = createPeer(from);
      if (description) {
        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { to: from, description: pc.localDescription });
        }
      }
      if (candidate) await pc.addIceCandidate(candidate);
    } catch (e) {
      console.warn("WebRTC signal error", e);
      showConnectionIssue(
        "Не удалось установить голосовое соединение. Попробуйте переподключиться.",
      );
    }
  });
  function showConnectionIssue(msg) {
    $("connectionNotice").textContent = msg;
    show($("connectionNotice"));
  }
  function hideConnectionIssue() {
    show($("connectionNotice"), false);
  }
  function renderMembers() {
    const list = [...state.members.values()];
    $("memberCount").textContent = list.length;
    $("membersGrid").innerHTML = list
      .map(
        (m) =>
          `<article class="member-card" data-member-card="${m.id}">${avatarMarkup(m)}<div class="member-name">${escapeText(m.name)}${m.id === state.selfId ? " (ты)" : ""}</div><div class="member-state ${m.muted ? "muted-label" : ""}">${m.muted ? "● Микрофон выключен" : '<span class="state-dot"></span> На связи'}</div>${m.id !== state.selfId ? `<div class="member-tools"><span>−</span><input type="range" min="0" max="1" step="0.05" value="${state.audioEls.get(m.id)?.volume ?? 1}" data-volume="${m.id}" aria-label="Громкость ${escapeText(m.name)}"><span>＋</span></div>` : ""}</article>`,
      )
      .join("");
    $("membersGrid")
      .querySelectorAll("[data-volume]")
      .forEach((slider) =>
        slider.addEventListener("input", () => {
          const audio = state.audioEls.get(slider.dataset.volume);
          if (audio) audio.volume = Number(slider.value);
        }),
      );
  }
  function enterRoom(code) {
    state.code = code;
    state.joinedAt = Date.now();
    $("roomCodeLabel").textContent = code;
    $("roomCode").value = "";
    show($("homeView"), false);
    show($("roomView"));
    show($("chatToggle"));
    clearNotice();
    renderMembers();
  }
  function exitRoom() {
    socket.emit("room:leave");
    for (const pc of state.peers.values()) pc.close();
    state.peers.clear();
    for (const audio of state.audioEls.values()) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    state.audioEls.clear();
    stopStream(state.localStream);
    state.localStream = null;
    state.members.clear();
    state.code = null;
    state.selfId = null;
    state.muted = false;
    show($("roomView"), false);
    show($("chatToggle"), false);
    show($("homeView"));
    $("muteButton").classList.remove("is-muted");
    $("muteLabel").textContent = "Выключить микрофон";
    $("chatDrawer").classList.remove("open");
    state.chatOpen = false;
    $("chatMessages").innerHTML =
      '<div class="chat-empty">Здесь появятся сообщения.<br>Начни разговор 👋</div>';
    hideConnectionIssue();
  }
  async function beginRoom(action) {
    clearNotice();
    state.pendingAction = action;
    $("gateName").value = state.profile.name || "";
    setAvatarPreview("gateAvatarPreview", state.profile.avatar);
    show($("profileGate"));
  }
  $("createRoom").onclick = () => beginRoom("create");
  $("joinRoom").onclick = () => {
    const code = $("roomCode").value.trim().toUpperCase();
    if (code.length < 4) return notice("Введи код комнаты из приглашения.");
    beginRoom("join");
    state.pendingCode = code;
  };
  $("roomCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinRoom").click();
  });
  $("confirmProfile").onclick = async () => {
    state.profile = {
      ...state.profile,
      name: ($("gateName").value || "Гость").trim().slice(0, 24) || "Гость",
    };
    $("confirmProfile").disabled = true;
    $("confirmProfile").textContent = "Подключаемся…";
    $("gateError").textContent = "";
    try {
      state.localStream = await getMedia();
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = true));
      const callback = (result) => {
        if (!result?.ok) {
          stopStream(state.localStream);
          state.localStream = null;
          $("gateError").textContent =
            result?.error || "Не удалось подключиться.";
          $("confirmProfile").disabled = false;
          $("confirmProfile").textContent = "Продолжить в комнату";
          return;
        }
        show($("profileGate"), false);
        enterRoom(result.code);
      };
      if (state.pendingAction === "create")
        socket.emit("room:create", state.profile, callback);
      else
        socket.emit(
          "room:join",
          { code: state.pendingCode, profile: state.profile },
          callback,
        );
    } catch (e) {
      $("gateError").textContent =
        e.name === "NotAllowedError"
          ? "Разреши доступ к микрофону в настройках браузера."
          : e.message || "Не удалось включить микрофон.";
      $("confirmProfile").disabled = false;
      $("confirmProfile").textContent = "Продолжить в комнату";
    }
  };
  $("leaveRoom").onclick = exitRoom;
  $("muteButton").onclick = () => {
    if (!state.localStream) return;
    state.muted = !state.muted;
    state.localStream
      .getAudioTracks()
      .forEach((t) => (t.enabled = !state.muted));
    $("muteButton").classList.toggle("is-muted", state.muted);
    $("muteLabel").textContent = state.muted
      ? "Включить микрофон"
      : "Выключить микрофон";
    socket.emit("member:mute", state.muted);
  };
  socket.on("room:state", ({ code, selfId, members }) => {
    state.code = code;
    state.selfId = selfId;
    state.members = new Map(members.map((m) => [m.id, m]));
    renderMembers();
  });
  socket.on("room:members", (members) => {
    state.members = new Map(members.map((m) => [m.id, m]));
    renderMembers();
  });
  socket.on("member:joined", async (member) => {
    state.members.set(member.id, member);
    renderMembers();
    try {
      await offerTo(member.id);
    } catch (e) {
      console.warn(e);
      showConnectionIssue("Не удалось подключить участника по голосу.");
    }
  });
  socket.on("member:left", ({ id }) => {
    state.members.delete(id);
    state.peers.get(id)?.close();
    state.peers.delete(id);
    const audio = state.audioEls.get(id);
    if (audio) {
      audio.remove();
      state.audioEls.delete(id);
    }
    renderMembers();
  });
  function openChat() {
    $("chatDrawer").classList.add("open");
    state.chatOpen = true;
    state.unread = 0;
    show($("chatUnread"), false);
    $("chatInput").focus();
  }
  $("chatToggle").onclick = openChat;
  $("closeChat").onclick = () => {
    $("chatDrawer").classList.remove("open");
    state.chatOpen = false;
  };
  $("chatForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("chatInput"),
      text = input.value.trim();
    if (!text || !state.code) return;
    socket.emit("chat:send", text);
    input.value = "";
  });
  socket.on("chat:message", (msg) => {
    const empty = $("chatMessages").querySelector(".chat-empty");
    if (empty) empty.remove();
    const item = document.createElement("div");
    item.className = "message";
    const avatar = msg.avatar
      ? `<img class="message-avatar" src="${msg.avatar}" alt="">`
      : `<div class="message-avatar">${escapeText(initials(msg.name))}</div>`;
    const time = new Date(msg.at).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
    item.innerHTML = `${avatar}<div class="message-body"><div class="message-meta"><strong>${escapeText(msg.name)}</strong><time>${time}</time></div><div class="message-text">${escapeText(msg.text)}</div></div>`;
    $("chatMessages").appendChild(item);
    $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
    if (!state.chatOpen && msg.memberId !== state.selfId) {
      state.unread++;
      show($("chatUnread"));
    }
  });

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }

      const temp = document.createElement("textarea");
      temp.value = text;
      temp.style.position = "fixed";
      temp.style.opacity = "0";
      document.body.appendChild(temp);
      temp.select();
      const copied = document.execCommand("copy");
      temp.remove();

      if (!copied) throw new Error("Не удалось скопировать");
      return true;
    } catch (error) {
      console.error("Ошибка копирования:", error);
      showConnectionIssue(
        "Не удалось скопировать. Проверь разрешения браузера.",
      );
      return false;
    }
  }

  async function copyRoomCode() {
    if (!state.code) return;

    if (await copyText(state.code)) {
      $("copyInvite").textContent = "✓";
      setTimeout(() => {
        $("copyInvite").textContent = "▢";
      }, 1800);
    }
  }

  async function copyInvite() {
    if (!state.code) return;

    const url = `${location.origin}${location.pathname}?room=${state.code}`;

    if (await copyText(url)) {
      $("copyInviteSide").textContent = "Ссылка скопирована ✓";
      setTimeout(() => {
        $("copyInviteSide").textContent = "Скопировать ссылку";
      }, 1800);
    }
  }

  $("copyInvite").onclick = copyRoomCode;
  $("copyInviteSide").onclick = copyInvite;
})();
