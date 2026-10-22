(() => {
  const socket = io({ autoConnect: false });
  const $ = (id) => document.getElementById(id);
  const state = {
    code: null,
    selfId: null,
    members: new Map(),
    peers: new Map(),
    localStream: null,
    micStream: null,
    noiseContext: null,
    noiseSource: null,
    noiseNode: null,
    noiseDestination: null,
    micDeviceId: "",
    muted: false,
    noiseSuppression: true,
    profile: { name: "", about: "", avatar: "", cover: "", friendId: "" },
    friends: [],
    authenticated: false,
    roomMinimized: false,
    authMode: "register",
    settingsOpen: false,
    chatOpen: false,
    unread: 0,
    micTestStream: null,
    micTestFrame: null,
    micTestContext: null,
    soundContext: null,
    audioEls: new Map(),
    screenAudioEls: new Map(),
    remoteScreens: new Map(),
    screenTiles: new Map(),
    screenStream: null,
    screenQuality: 1080,
    screenFrameRate: 60,
    screenBitrate: 12_000_000,
    expandedScreenId: null,
    screenAudioEnabled: false,
    screenSettingsOpen: false,
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
  function unlockSoundContext() {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return null;

    try {
      state.soundContext ||= new AudioContext();
      const context = state.soundContext;
      if (context.state === "suspended") context.resume().catch(console.warn);
      return context;
    } catch (error) {
      console.warn("Не удалось запустить системные звуки:", error);
      return null;
    }
  }
  function playUiSound(kind) {
    const context = unlockSoundContext();
    if (!context) return;

    try {
      const sequences = {
        join: [
          { frequency: 523.25, delay: 0, duration: 0.2 },
          { frequency: 783.99, delay: 0.12, duration: 0.27 },
        ],
        leave: [
          { frequency: 783.99, delay: 0, duration: 0.2 },
          { frequency: 523.25, delay: 0.12, duration: 0.27 },
        ],
        micOn: [{ frequency: 880, delay: 0, duration: 0.16 }],
        micOff: [{ frequency: 440, delay: 0, duration: 0.16 }],
      };

      for (const note of sequences[kind] || []) {
        const start = context.currentTime + note.delay;
        const end = start + note.duration;
        const tone = context.createOscillator();
        const overtone = context.createOscillator();
        const toneGain = context.createGain();
        const overtoneGain = context.createGain();
        const filter = context.createBiquadFilter();
        filter.type = "lowpass";
        filter.frequency.value = 2800;
        tone.type = "sine";
        overtone.type = "sine";
        tone.frequency.setValueAtTime(note.frequency, start);
        overtone.frequency.setValueAtTime(note.frequency * 2, start);
        toneGain.gain.setValueAtTime(0.0001, start);
        toneGain.gain.linearRampToValueAtTime(0.045, start + 0.025);
        toneGain.gain.exponentialRampToValueAtTime(0.0001, end);
        overtoneGain.gain.setValueAtTime(0.0001, start);
        overtoneGain.gain.linearRampToValueAtTime(0.008, start + 0.025);
        overtoneGain.gain.exponentialRampToValueAtTime(0.0001, end);
        tone.connect(toneGain);
        overtone.connect(overtoneGain);
        toneGain.connect(filter);
        overtoneGain.connect(filter);
        filter.connect(context.destination);
        tone.start(start);
        overtone.start(start);
        tone.stop(end + 0.01);
        overtone.stop(end + 0.01);
      }
    } catch (error) {
      console.warn("Не удалось воспроизвести системный звук:", error);
    }
  }
  function notice(message) {
    $("homeError").textContent = message;
    show($("homeError"));
  }
  function clearNotice() {
    show($("homeError"), false);
  }
  async function api(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "Не удалось выполнить запрос.");
    return result;
  }
  function renderAccount() {
    show($("accountHome"), state.authenticated);
    show($("topbarAccount"));
    show($("openRegister"), !state.authenticated);
    show($("openLogin"), !state.authenticated);
    show($("profileNav"), state.authenticated);
    if (!state.authenticated) return;

    $("profileName").textContent = state.profile.name;
    $("profileFriendId").textContent = state.profile.friendId;
    $("profileAbout").textContent = state.profile.about || "Расскажи друзьям немного о себе.";
    $("profileAvatar").textContent = state.profile.avatar ? "" : initials(state.profile.name);
    $("profileAvatar").style.backgroundImage = state.profile.avatar
      ? `url("${state.profile.avatar}")`
      : "";
    $("profileNavAvatar").textContent = state.profile.avatar
      ? ""
      : initials(state.profile.name);
    $("profileNav").style.backgroundImage = state.profile.avatar
      ? `url("${state.profile.avatar}")`
      : "";
    $("profileCover").src = state.profile.cover || "";
    show($("profileCover"), Boolean(state.profile.cover));
    $("friendsCount").textContent = String(state.friends.length);
    $("friendsList").replaceChildren();
    if (!state.friends.length) {
      const empty = document.createElement("p");
      empty.className = "friends-empty";
      empty.textContent = "Пока никого нет — добавь друга по его ID.";
      $("friendsList").append(empty);
      return;
    }
    for (const friend of state.friends) {
      const row = document.createElement("div");
      row.className = "friend-row";
      const avatar = document.createElement("div");
      avatar.className = "friend-avatar";
      if (friend.avatar) {
        avatar.style.backgroundImage = `url("${friend.avatar}")`;
      } else {
        avatar.textContent = initials(friend.name);
      }
      const identity = document.createElement("div");
      identity.className = "friend-identity";
      const name = document.createElement("strong");
      name.textContent = friend.name;
      const id = document.createElement("span");
      id.textContent = `ID: ${friend.friendId}`;
      identity.append(name, id);
      row.append(avatar, identity);
      $("friendsList").append(row);
    }
  }
  async function loadAccount() {
    try {
      const { user, friends } = await api("/api/me");
      if (!user) {
        state.authenticated = false;
        renderAccount();
        applyPageFromHash();
        return;
      }
      state.profile = user;
      state.friends = friends;
      state.authenticated = true;
      renderAccount();
      applyPageFromHash();
      socket.connect();
    } catch (error) {
      notice(error.message);
      state.authenticated = false;
      renderAccount();
      applyPageFromHash();
    }
  }
  function applyPageFromHash() {
    const hash = window.location.hash;
    if (hash === "#room" && !state.code) {
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
    }
    if (hash === "#profile" && state.code) {
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
    } else if (hash === "#profile" && !state.authenticated) {
      history.replaceState(null, "", `${location.pathname}${location.search}`);
      openAuth("register");
    }
    const currentHash = window.location.hash;
    const roomPage = Boolean(state.code) && currentHash === "#room";
    const profilePage =
      !state.code && currentHash === "#profile" && state.authenticated;
    state.roomMinimized = Boolean(state.code) && !roomPage;
    show($("roomView"), roomPage);
    show($("roomDock"), state.roomMinimized);
    show($("profileView"), profilePage);
    show($("homeView"), !roomPage && !profilePage);
    show($("topbarAccount"), !roomPage);
    show($("chatToggle"), roomPage);
  }
  function navigateHome() {
    if (state.code) {
      if (window.location.hash !== "#home") {
        history.pushState(null, "", `${location.pathname}${location.search}#home`);
      }
      applyPageFromHash();
      return;
    }
    if (window.location.hash !== "#home") {
      history.pushState(null, "", `${location.pathname}${location.search}#home`);
    }
    applyPageFromHash();
  }
  function navigateToProfile() {
    if (!state.authenticated || state.code) return;
    if (window.location.hash !== "#profile") {
      history.pushState(null, "", `${location.pathname}${location.search}#profile`);
    }
    applyPageFromHash();
  }
  $("profileNav").onclick = navigateToProfile;
  $("backHome").onclick = navigateHome;
  $("roomDock").onclick = () => {
    if (!state.code) return;
    if (window.location.hash !== "#room") {
      history.pushState(null, "", `${location.pathname}${location.search}#room`);
    }
    applyPageFromHash();
  };
  document.querySelector(".brand").addEventListener("click", (event) => {
    event.preventDefault();
    navigateHome();
  });
  window.addEventListener("popstate", applyPageFromHash);
  window.addEventListener("hashchange", applyPageFromHash);
  function openAuth(mode) {
    state.authMode = mode;
    const registering = mode === "register";
    $("authTitle").textContent = registering ? "Создать аккаунт" : "Войти";
    $("authSubmit").textContent = registering ? "Создать аккаунт" : "Войти";
    $("registerNameGroup").classList.toggle("hidden", !registering);
    $("authPassword").autocomplete = registering ? "new-password" : "current-password";
    $("switchAuthMode").textContent = registering
      ? "Уже есть аккаунт? Войти"
      : "Нет аккаунта? Создать";
    $("authError").textContent = "";
    show($("authBackdrop"));
    $("authLogin").focus();
  }
  $("openRegister").onclick = () => openAuth("register");
  $("openLogin").onclick = () => openAuth("login");
  $("closeAuth").onclick = () => show($("authBackdrop"), false);
  $("switchAuthMode").onclick = () =>
    openAuth(state.authMode === "register" ? "login" : "register");
  $("authBackdrop").addEventListener("click", (event) => {
    if (event.target === $("authBackdrop")) show($("authBackdrop"), false);
  });
  $("authForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const submit = $("authSubmit");
    submit.disabled = true;
    $("authError").textContent = "";
    try {
      const endpoint = state.authMode === "register" ? "/api/register" : "/api/login";
      const result = await api(endpoint, {
        method: "POST",
        body: JSON.stringify({
          name: $("registerName").value,
          login: $("authLogin").value,
          password: $("authPassword").value,
        }),
      });
      state.profile = result.user;
      state.friends = result.friends;
      state.authenticated = true;
      renderAccount();
      applyPageFromHash();
      show($("authBackdrop"), false);
      $("authForm").reset();
      socket.connect();
    } catch (error) {
      $("authError").textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  $("logout").onclick = async () => {
    try {
      await api("/api/logout", { method: "POST" });
      socket.disconnect();
      state.authenticated = false;
      state.profile = { name: "", about: "", avatar: "", cover: "", friendId: "" };
      state.friends = [];
      renderAccount();
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
      applyPageFromHash();
    } catch (error) {
      notice(error.message);
    }
  };
  $("addFriendForm").addEventListener("submit", async (event) => {
    event.preventDefault();
    const input = $("friendIdInput");
    $("friendError").textContent = "";
    try {
      await api("/api/friends", {
        method: "POST",
        body: JSON.stringify({ friendId: input.value }),
      });
      const result = await api("/api/friends");
      state.friends = result.friends;
      input.value = "";
      renderAccount();
      $("friendError").textContent = "Добавили в друзья.";
    } catch (error) {
      $("friendError").textContent = error.message;
    }
  });
  $("copyFriendId").onclick = async () => {
    if (await copyText(state.profile.friendId)) {
      $("copyFriendId").textContent = "Скопировано";
      setTimeout(() => ($("copyFriendId").textContent = "Копировать"), 1500);
    }
  };
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
    const avatar = member.avatar
      ? `<img class="member-avatar-image" src="${member.avatar}" alt="">`
      : `<span class="member-avatar-initials">${escapeText(initials(member.name))}</span>`;
    return `<button class="${cls} member-avatar-button" type="button" data-profile-member="${escapeText(member.id)}" aria-label="Открыть профиль ${escapeText(member.name)}">${avatar}</button>`;
  }
  function readProfile() {
    return {
      name:
        $("displayName").value.trim().slice(0, 24) || state.profile.name,
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
      $("profileSettingsError").textContent =
        "Выбери картинку PNG, JPG, WebP или GIF до 1,5 МБ.";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.profile.avatar = String(reader.result);
      setAvatarPreview(previewId, state.profile.avatar);
      $("profileSettingsError").textContent = "";
    };
    reader.readAsDataURL(file);
  }
  function useCoverFile(file) {
    if (!file) return;
    if (
      !/^image\/(png|jpeg|webp|gif)$/.test(file.type) ||
      file.size > 2_000_000
    ) {
      $("profileSettingsError").textContent =
        "Выбери картинку PNG, JPG, WebP или GIF до 2 МБ.";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      state.profile.cover = String(reader.result);
      $("coverPreview").src = state.profile.cover;
      show($("coverPreview"));
      $("profileSettingsError").textContent = "";
    };
    reader.readAsDataURL(file);
  }
  $("avatarFile").addEventListener("change", (e) =>
    useAvatarFile(e.target.files[0], "avatarPreview"),
  );
  $("coverFile").addEventListener("change", (e) =>
    useCoverFile(e.target.files[0]),
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
      noiseSuppression: false,
      autoGainControl: false,
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
  async function createOutgoingAudio(micStream, noiseSuppression) {
    if (!noiseSuppression) return { stream: micStream, context: null };
    if (!window.AudioContext || !window.AudioWorkletNode) {
      throw new Error(
        "RNNoise требует браузер с поддержкой AudioWorklet. Обнови браузер или отключи шумоподавление.",
      );
    }

    const suppressor = await import("/noise-suppressor/index.js");
    const context = new AudioContext({ sampleRate: 48000 });
    try {
      if (context.sampleRate !== 48000) {
        throw new Error(
          "Браузер не поддерживает обработку звука 48 кГц, необходимую RNNoise.",
        );
      }
      await context.audioWorklet.addModule(
        "/noise-suppressor/rnnoise/workletProcessor.js",
      );
      const wasmBinary = await suppressor.loadRnnoise({
        url: "/noise-suppressor/rnnoise.wasm",
        simdUrl: "/noise-suppressor/rnnoise_simd.wasm",
      });
      const source = context.createMediaStreamSource(micStream);
      const noiseNode = new suppressor.RnnoiseWorkletNode(context, {
        wasmBinary,
        maxChannels: 1,
      });
      const destination = context.createMediaStreamDestination();
      source.connect(noiseNode);
      noiseNode.connect(destination);
      await context.resume();
      return {
        stream: destination.stream,
        context,
        source,
        noiseNode,
        destination,
      };
    } catch (error) {
      await context.close();
      throw error;
    }
  }
  async function replaceOutgoingAudio(micStream, noiseSuppression) {
    const next = await createOutgoingAudio(micStream, noiseSuppression);
    const replacedSenders = [];
    try {
      const nextTrack = next.stream.getAudioTracks()[0];
      for (const pc of state.peers.values()) {
        const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
        if (sender) {
          await sender.replaceTrack(nextTrack);
          replacedSenders.push(sender);
        }
      }
    } catch (error) {
      const currentTrack = state.localStream?.getAudioTracks()[0] || null;
      await Promise.allSettled(
        replacedSenders.map((sender) => sender.replaceTrack(currentTrack)),
      );
      stopStream(next.stream === micStream ? null : next.stream);
      await next.context?.close();
      throw error;
    }

    const oldStream = state.localStream;
    const oldContext = state.noiseContext;
    state.localStream = next.stream;
    state.noiseContext = next.context;
    state.noiseSource = next.source || null;
    state.noiseNode = next.noiseNode || null;
    state.noiseDestination = next.destination || null;
    if (oldStream && oldStream !== state.micStream) stopStream(oldStream);
    if (oldContext) await oldContext.close();
  }
  async function stopNoiseProcessing() {
    state.noiseSource?.disconnect();
    state.noiseNode?.destroy();
    state.noiseNode?.disconnect();
    state.noiseDestination?.stream.getTracks().forEach((track) => track.stop());
    if (state.noiseContext) await state.noiseContext.close();
    state.noiseContext = null;
    state.noiseSource = null;
    state.noiseNode = null;
    state.noiseDestination = null;
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
  function setSettingsTab(tab) {
    const profileActive = tab === "profile";
    show($("profileSettingsTab"), profileActive);
    show($("soundSettingsTab"), !profileActive);
    $("profileSettingsTabButton").classList.toggle("is-active", profileActive);
    $("soundSettingsTabButton").classList.toggle("is-active", !profileActive);
    $("profileSettingsTabButton").setAttribute(
      "aria-selected",
      String(profileActive),
    );
    $("soundSettingsTabButton").setAttribute(
      "aria-selected",
      String(!profileActive),
    );
  }
  function openSettings(tab = "sound") {
    if (!state.authenticated) {
      openAuth("register");
      return;
    }
    $("displayName").value = state.profile.name || "";
    $("profileAboutInput").value = state.profile.about || "";
    $("friendIdEdit").value = state.profile.friendId || "";
    $("noiseSuppression").checked = state.noiseSuppression;
    setAvatarPreview("avatarPreview", state.profile.avatar);
    $("coverPreview").src = state.profile.cover || "";
    show($("coverPreview"), Boolean(state.profile.cover));
    $("profileSettingsError").textContent = "";
    $("soundSettingsError").textContent = "";
    show($("modalBackdrop"));
    state.settingsOpen = true;
    setSettingsTab(tab);
    refreshDevices();
  }
  function closeSettings() {
    show($("modalBackdrop"), false);
    state.settingsOpen = false;
    stopMicTest();
  }
  $("openSettingsHome").onclick = openSettings;
  $("editProfile").onclick = () => openSettings("profile");
  $("settingsRoom").onclick = openSettings;
  $("profileSettingsTabButton").onclick = () => setSettingsTab("profile");
  $("soundSettingsTabButton").onclick = () => setSettingsTab("sound");
  $("closeSettings").onclick = closeSettings;
  $("modalBackdrop").addEventListener("click", (e) => {
    if (e.target === $("modalBackdrop")) closeSettings();
  });
  $("saveProfileSettings").onclick = async () => {
    try {
      const { user } = await api("/api/profile", {
        method: "PUT",
        body: JSON.stringify({
          ...state.profile,
          ...readProfile(),
          about: $("profileAboutInput").value,
          friendId: $("friendIdEdit").value,
        }),
      });
      state.profile = user;
      renderAccount();
    } catch (error) {
      $("profileSettingsError").textContent = error.message;
      return;
    }
    closeSettings();
  };
  $("saveSettings").onclick = async () => {
    $("soundSettingsError").textContent = "";
    const noiseSuppression = $("noiseSuppression").checked;
    const deviceId = $("micSelect").value;
    const deviceChanged = state.micStream && deviceId !== state.micDeviceId;
    const noiseChanged =
      state.micStream && noiseSuppression !== state.noiseSuppression;
    if (deviceChanged || noiseChanged) {
      let nextMicStream = state.micStream;
      try {
        if (deviceChanged) nextMicStream = await getMedia();
        await replaceOutgoingAudio(nextMicStream, noiseSuppression);
        if (deviceChanged) {
          stopStream(state.micStream);
          state.micStream = nextMicStream;
        }
        state.micDeviceId = deviceId;
      } catch (e) {
        if (deviceChanged && nextMicStream !== state.micStream)
          stopStream(nextMicStream);
        $("soundSettingsError").textContent =
          e.message || "Не удалось переключить микрофон.";
        return;
      }
    }
    state.noiseSuppression = noiseSuppression;
    if (state.localStream) {
      state.localStream
        .getAudioTracks()
        .forEach((t) => (t.enabled = !state.muted));
    }
    renderMembers();
    renderScreenStage();
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

  function addScreenTracks(pc, stream) {
    stream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, stream);
      if (track.kind !== "video") return;
      pc.screenSenderConfig = (pc.screenSenderConfig || Promise.resolve())
        .then(async () => {
          const parameters = sender.getParameters();
          if (!parameters.encodings.length) return;
          parameters.degradationPreference = "maintain-resolution";
          parameters.encodings[0].maxBitrate = state.screenBitrate;
          parameters.encodings[0].maxFramerate = state.screenFrameRate;
          parameters.encodings[0].scaleResolutionDownBy = 1;
          await sender.setParameters(parameters);
        })
        .catch((error) => {
          console.warn("Не удалось настроить качество демонстрации:", error);
          showConnectionIssue(
            "Браузер не применил настройки качества демонстрации.",
          );
        });
    });
  }
  function createPeer(id) {
    if (state.peers.has(id)) return state.peers.get(id);
    const pc = new RTCPeerConnection(rtcConfig);
    pc.polite = String(state.selfId).localeCompare(String(id)) > 0;
    pc.makingOffer = false;
    pc.ignoreOffer = false;
    pc.isSettingRemoteAnswerPending = false;
    state.peers.set(id, pc);
    state.localStream
      ?.getTracks()
      .forEach((track) => pc.addTrack(track, state.localStream));
    if (state.screenStream) addScreenTracks(pc, state.screenStream);
    pc.onicecandidate = (e) => {
      if (e.candidate)
        socket.emit("signal", { to: id, candidate: e.candidate });
    };
    pc.onnegotiationneeded = async () => {
      try {
        await pc.screenSenderConfig;
        pc.makingOffer = true;
        await pc.setLocalDescription();
        socket.emit("signal", { to: id, description: pc.localDescription });
      } catch (error) {
        if (pc.signalingState !== "closed") {
          console.warn("Не удалось обновить голосовое соединение:", error);
          showConnectionIssue("Не удалось обновить голосовое соединение.");
        }
      } finally {
        pc.makingOffer = false;
      }
    };
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track]);
      if (
        stream.getVideoTracks().length ||
        state.members.get(id)?.screenSharing
      )
        attachRemoteScreen(id, stream);
      else if (e.track.kind === "audio") attachAudio(id, stream);
    };
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
  function setScreenAudioPlayback() {
    for (const [memberId, audio] of state.screenAudioEls) {
      audio.muted =
        state.expandedScreenId !== memberId || !state.screenAudioEnabled;
      if (!audio.muted) {
        audio.play().catch(() =>
          showConnectionIssue(
            "Нажми на страницу, чтобы разрешить воспроизведение звука демонстрации.",
          ),
        );
      }
    }
  }
  function removeRemoteScreen(id) {
    state.remoteScreens.delete(id);
    const audio = state.screenAudioEls.get(id);
    if (audio) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
      state.screenAudioEls.delete(id);
    }
    if (state.expandedScreenId === id) {
      state.expandedScreenId = null;
      state.screenAudioEnabled = false;
      $("roomView").classList.remove("is-screen-expanded");
    }
    renderScreenStage();
  }
  function attachRemoteScreen(id, stream) {
    state.remoteScreens.set(id, stream);
    const audioTrack = stream.getAudioTracks()[0];
    if (audioTrack) {
      let audio = state.screenAudioEls.get(id);
      if (!audio) {
        audio = document.createElement("audio");
        audio.autoplay = true;
        audio.playsInline = true;
        audio.dataset.screenAudio = id;
        audio.style.display = "none";
        document.body.appendChild(audio);
        state.screenAudioEls.set(id, audio);
      }
      audio.srcObject = stream;
      audio.muted = state.expandedScreenId !== id;
      if (audio.muted) audio.play().catch(() => {});
    }
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) videoTrack.onended = () => removeRemoteScreen(id);
    renderScreenStage();
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
  socket.on("signal", async ({ from, description, candidate }) => {
    try {
      const pc = createPeer(from);
      if (description) {
        const readyForOffer =
          !pc.makingOffer &&
          (pc.signalingState === "stable" || pc.isSettingRemoteAnswerPending);
        const offerCollision =
          description.type === "offer" && !readyForOffer;
        pc.ignoreOffer = !pc.polite && offerCollision;
        if (pc.ignoreOffer) return;
        pc.isSettingRemoteAnswerPending = description.type === "answer";
        await pc.setRemoteDescription(description);
        pc.isSettingRemoteAnswerPending = false;
        if (description.type === "offer") {
          await pc.setLocalDescription();
          socket.emit("signal", { to: from, description: pc.localDescription });
        }
      }
      if (candidate && !pc.ignoreOffer) await pc.addIceCandidate(candidate);
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
  function openMemberProfile(memberId) {
    const member = state.members.get(memberId);
    if (!member) return;

    $("memberProfileName").textContent =
      member.name + (member.id === state.selfId ? " (ты)" : "");
    $("memberProfileAbout").textContent =
      member.about || "Пользователь пока ничего не рассказал о себе.";
    $("memberProfileFriendId").textContent = member.friendId
      ? `@${member.friendId}`
      : "ID не указан";

    const avatar = $("memberProfileAvatar");
    avatar.textContent = member.avatar ? "" : initials(member.name);
    avatar.style.backgroundImage = member.avatar
      ? `url("${member.avatar}")`
      : "";
    const cover = $("memberProfileCover");
    cover.src = member.cover || "";
    show(cover, Boolean(member.cover));
    show($("memberProfileBackdrop"));
  }
  function closeMemberProfile() {
    show($("memberProfileBackdrop"), false);
  }
  $("participantsGrid").addEventListener("click", (event) => {
    const avatarButton = event.target.closest("[data-profile-member]");
    if (avatarButton) openMemberProfile(avatarButton.dataset.profileMember);
  });
  $("closeMemberProfile").onclick = closeMemberProfile;
  $("memberProfileBackdrop").addEventListener("click", (event) => {
    if (event.target === $("memberProfileBackdrop")) closeMemberProfile();
  });
  function renderMembers() {
    const list = [...state.members.values()];
    $("memberCount").textContent = list.length;
    $("participantsGrid").innerHTML = list
      .map(
        (m) =>
          `<article class="member-card" data-member-card="${m.id}">${avatarMarkup(m)}<div class="member-name">${escapeText(m.name)}${m.id === state.selfId ? " (ты)" : ""}</div><div class="member-state ${m.muted ? "muted-label" : ""}">${m.muted ? "● Микрофон выключен" : '<span class="state-dot"></span> На связи'}</div>${m.id !== state.selfId ? `<div class="member-tools"><span>−</span><input type="range" min="0" max="1" step="0.05" value="${state.audioEls.get(m.id)?.volume ?? 1}" data-volume="${m.id}" aria-label="Громкость ${escapeText(m.name)}"><span>＋</span></div>` : ""}</article>`,
      )
      .join("");
    $("participantsGrid")
      .querySelectorAll("[data-volume]")
      .forEach((slider) =>
        slider.addEventListener("input", () => {
          const audio = state.audioEls.get(slider.dataset.volume);
          if (audio) audio.volume = Number(slider.value);
        }),
      );
  }
  function renderScreenStage() {
    const stage = $("screenStage");
    const screens = [];
    if (state.screenStream) {
      screens.push({
        id: state.selfId,
        name: "Твоя демонстрация",
        stream: state.screenStream,
        local: true,
      });
    }
    for (const [id, stream] of state.remoteScreens) {
      if (!stream.getVideoTracks().length) continue;
      screens.push({
        id,
        name: state.members.get(id)?.name || "Участник",
        stream,
        local: false,
      });
    }
    show(stage, screens.length > 0);
    $("roomView").classList.toggle(
      "has-screen-share",
      screens.length > 0,
    );
    if (!screens.length) {
      stage.replaceChildren();
      state.screenTiles.clear();
      return;
    }

    const gallery = document.createElement("div");
    gallery.className = "screen-gallery";
    gallery.classList.toggle(
      "has-expanded-screen",
      Boolean(state.expandedScreenId),
    );
    const currentIds = new Set(screens.map((screen) => screen.id));
    for (const [id, tile] of state.screenTiles) {
      if (!currentIds.has(id)) {
        tile.card.remove();
        state.screenTiles.delete(id);
      }
    }
    for (const screen of screens) {
      let tile = state.screenTiles.get(screen.id);
      if (!tile || tile.stream !== screen.stream) {
        tile?.card.remove();
        const card = document.createElement("article");
        card.className = "screen-card";
        card.dataset.screenMember = screen.id;
        const preview = document.createElement("button");
        preview.className = "screen-preview";
        preview.type = "button";
        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.srcObject = screen.stream;
        preview.append(video);
        preview.addEventListener("click", () =>
          toggleExpandedScreen(screen.id),
        );
        const details = document.createElement("div");
        details.className = "screen-card-details";
        const label = document.createElement("span");
        label.className = "screen-card-name";
        const hint = document.createElement("span");
        hint.className = "screen-card-hint";
        details.append(label, hint);
        card.append(preview, details);
        tile = { card, stream: screen.stream, video, preview, label, hint };
        state.screenTiles.set(screen.id, tile);
      }
      tile.card.classList.toggle(
        "is-expanded",
        state.expandedScreenId === screen.id,
      );
      tile.preview.setAttribute(
        "aria-label",
        `${state.expandedScreenId === screen.id ? "Свернуть" : "Развернуть"}: ${screen.name}`,
      );
      tile.label.textContent = screen.name;
      tile.hint.textContent =
        screen.local
          ? `${state.screenQuality}p · ${state.screenFrameRate} кадров/с`
          : state.expandedScreenId === screen.id
            ? "Демонстрация открыта"
            : "Нажми, чтобы развернуть";
      const sound = tile.card.querySelector(".screen-audio-toggle");
      if (screen.stream.getAudioTracks().length && !sound) {
        const button = document.createElement("button");
        button.className = "screen-audio-toggle";
        button.type = "button";
        button.addEventListener("click", () => {
          state.screenAudioEnabled = !state.screenAudioEnabled;
          setScreenAudioPlayback();
          renderScreenStage();
        });
        tile.card.append(button);
      } else if (!screen.stream.getAudioTracks().length) {
        sound?.remove();
      }
      const audioToggle = tile.card.querySelector(".screen-audio-toggle");
      if (audioToggle) {
        audioToggle.textContent =
          state.expandedScreenId === screen.id &&
          state.screenAudioEnabled
            ? "Звук включён"
            : "Включить звук";
        audioToggle.disabled = state.expandedScreenId !== screen.id;
      }
      let stop = tile.card.querySelector(".screen-stop-button");
      if (screen.local && !stop) {
        stop = document.createElement("button");
        stop.className = "screen-stop-button";
        stop.type = "button";
        stop.textContent = "Остановить показ";
        stop.addEventListener("click", stopLocalScreenShare);
        tile.card.append(stop);
      } else if (!screen.local) {
        stop?.remove();
      }
      gallery.append(tile.card);
      tile.video.play().catch(() => {});
    }
    stage.replaceChildren();
    stage.append(gallery);
    if (state.expandedScreenId) {
      const collapse = document.createElement("button");
      collapse.className = "screen-collapse-button";
      collapse.type = "button";
      collapse.textContent = "Свернуть демонстрацию";
      collapse.addEventListener("click", () => toggleExpandedScreen(null));
      stage.append(collapse);
    }
    setScreenAudioPlayback();
  }
  function toggleExpandedScreen(id) {
    const selectedId = state.expandedScreenId === id ? null : id;
    const transitionId = selectedId || state.expandedScreenId;
    const currentCard = [...$("screenStage").querySelectorAll(".screen-card")]
      .find((card) => card.dataset.screenMember === transitionId);
    const currentVideo = currentCard?.querySelector("video");
    const startBounds = currentVideo?.getBoundingClientRect();
    const update = () => {
      state.expandedScreenId = selectedId;
      state.screenAudioEnabled = Boolean(selectedId);
      $("roomView").classList.toggle(
        "is-screen-expanded",
        Boolean(selectedId),
      );
      renderScreenStage();
    };
    update();
    if (currentVideo?.animate && startBounds) {
      requestAnimationFrame(() => {
        const endBounds = currentVideo.getBoundingClientRect();
        if (!endBounds.width || !endBounds.height) return;
        currentVideo.animate(
          [
            {
              transformOrigin: "top left",
              transform: `translate(${startBounds.left - endBounds.left}px, ${startBounds.top - endBounds.top}px) scale(${startBounds.width / endBounds.width}, ${startBounds.height / endBounds.height})`,
            },
            {
              transformOrigin: "top left",
              transform: "translate(0, 0) scale(1, 1)",
            },
          ],
          { duration: 420, easing: "cubic-bezier(.2, .8, .2, 1)" },
        );
      });
    }
  }
  function closeScreenSettings() {
    show($("screenSettingsBackdrop"), false);
    state.screenSettingsOpen = false;
    $("screenSettingsError").textContent = "";
  }
  function openScreenSettings() {
    if (state.screenStream) return;
    $("screenSettingsError").textContent = "";
    show($("screenSettingsBackdrop"));
    state.screenSettingsOpen = true;
  }
  async function startScreenShare() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      $("screenSettingsError").textContent =
        "Демонстрация экрана недоступна. Открой сайт по HTTPS или через localhost в современном браузере.";
      return;
    }

    const height = Number($("screenQuality").value);
    const frameRate = Number($("screenFrameRate").value);
    const dimensions = {
      1080: { width: 1920, height: 1080 },
      720: { width: 1280, height: 720 },
      480: { width: 854, height: 480 },
    }[height];
    const includeAudio = $("screenAudio").checked;
    const options = {
      video: {
        width: { ideal: dimensions.width, max: dimensions.width },
        height: { ideal: dimensions.height, max: dimensions.height },
        frameRate: { ideal: frameRate, max: frameRate },
      },
      audio: includeAudio,
      preferCurrentTab: false,
      selfBrowserSurface: "include",
      systemAudio: includeAudio ? "include" : "exclude",
      surfaceSwitching: "include",
      monitorTypeSurfaces: "include",
    };

    $("startScreenShare").disabled = true;
    $("startScreenShare").textContent = "Выбираем экран…";
    $("screenSettingsError").textContent = "";
    let capture;
    try {
      capture = navigator.mediaDevices.getDisplayMedia(options);
    } catch (error) {
      $("screenSettingsError").textContent =
        error.message || "Не удалось открыть выбор экрана.";
      $("startScreenShare").disabled = false;
      $("startScreenShare").textContent = "Выбрать экран";
      return;
    }
    closeScreenSettings();

    try {
      const stream = await capture;
      if (!stream.getVideoTracks().length) {
        stopStream(stream);
        throw new Error("Браузер не предоставил видео выбранного экрана.");
      }
      state.screenStream = stream;
      state.screenQuality = height;
      state.screenFrameRate = frameRate;
      state.screenBitrate =
        height === 1080 ? 12_000_000 : height === 720 ? 6_000_000 : 3_000_000;
      const videoTrack = stream.getVideoTracks()[0];
      videoTrack.onended = stopLocalScreenShare;
      for (const pc of state.peers.values()) {
        addScreenTracks(pc, stream);
      }
      socket.emit("screen-share:state", true);
      $("screenShareLabel").textContent = "Остановить показ";
      renderScreenStage();
    } catch (error) {
      if (error.name !== "AbortError" && error.name !== "NotAllowedError") {
        console.error("Не удалось начать демонстрацию экрана:", error);
        showConnectionIssue(
          error.message || "Не удалось начать демонстрацию экрана.",
        );
      } else if (error.name === "NotAllowedError") {
        showConnectionIssue(
          "Браузер не разрешил захват экрана или системного звука.",
        );
      }
    } finally {
      $("startScreenShare").disabled = false;
      $("startScreenShare").textContent = "Выбрать экран";
    }
  }
  function stopLocalScreenShare() {
    const stream = state.screenStream;
    if (!stream) return;
    state.screenStream = null;
    const tracks = new Set(stream.getTracks());
    for (const pc of state.peers.values()) {
      for (const sender of pc.getSenders()) {
        if (tracks.has(sender.track)) pc.removeTrack(sender);
      }
    }
    stream.getVideoTracks().forEach((track) => {
      track.onended = null;
    });
    stopStream(stream);
    socket.emit("screen-share:state", false);
    state.expandedScreenId = null;
    state.screenAudioEnabled = false;
    $("roomView").classList.remove("is-screen-expanded");
    $("screenShareLabel").textContent = "Показать экран";
    renderScreenStage();
  }
  $("screenShareButton").addEventListener("click", () => {
    if (state.screenStream) stopLocalScreenShare();
    else openScreenSettings();
  });
  $("closeScreenSettings").addEventListener("click", closeScreenSettings);
  $("cancelScreenSettings").addEventListener("click", closeScreenSettings);
  $("screenSettingsBackdrop").addEventListener("click", (event) => {
    if (event.target === $("screenSettingsBackdrop")) closeScreenSettings();
  });
  $("startScreenShare").addEventListener("click", startScreenShare);
  function enterRoom(code) {
    state.code = code;
    state.joinedAt = Date.now();
    $("roomCodeLabel").textContent = code;
    $("roomCode").value = "";
    history.pushState(null, "", `${location.pathname}${location.search}#room`);
    applyPageFromHash();
    clearNotice();
    renderMembers();
    renderScreenStage();
  }
  async function exitRoom() {
    closeMemberProfile();
    playUiSound("leave");
    stopLocalScreenShare();
    socket.emit("room:leave");
    for (const pc of state.peers.values()) pc.close();
    state.peers.clear();
    for (const audio of state.audioEls.values()) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    state.audioEls.clear();
    for (const audio of state.screenAudioEls.values()) {
      audio.pause();
      audio.srcObject = null;
      audio.remove();
    }
    state.screenAudioEls.clear();
    state.remoteScreens.clear();
    state.expandedScreenId = null;
    state.screenAudioEnabled = false;
    state.screenStream = null;
    $("roomView").classList.remove(
      "has-screen-share",
      "is-screen-expanded",
    );
    show($("screenStage"), false);
    await stopNoiseProcessing();
    stopStream(state.micStream);
    if (state.localStream !== state.micStream) stopStream(state.localStream);
    state.localStream = null;
    state.micStream = null;
    state.micDeviceId = "";
    state.members.clear();
    state.code = null;
    state.selfId = null;
    state.muted = false;
    state.roomMinimized = false;
    if (window.location.hash === "#room") {
      history.replaceState(null, "", `${location.pathname}${location.search}#home`);
    }
    show($("roomView"), false);
    show($("roomDock"), false);
    show($("chatToggle"), false);
    show($("homeView"));
    show($("profileView"), false);
    show($("topbarAccount"), state.authenticated);
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
    if (!state.authenticated) {
      openAuth("register");
      return;
    }
    if (!socket.connected) {
      notice("Подключаемся к серверу. Попробуй ещё раз через секунду.");
      socket.connect();
      return;
    }
    await startRoom(action);
  }
  $("createRoom").onclick = () => beginRoom("create");
  $("joinRoom").onclick = () => {
    const code = $("roomCode").value.trim().toUpperCase();
    if (code.length < 4) return notice("Введи код комнаты из приглашения.");
    state.pendingCode = code;
    beginRoom("join");
  };
  $("roomCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("joinRoom").click();
  });
  async function startRoom(action) {
    unlockSoundContext();
    try {
      state.micStream = await getMedia();
      state.micDeviceId = $("micSelect").value;
      const outgoing = await createOutgoingAudio(
        state.micStream,
        state.noiseSuppression,
      );
      state.localStream = outgoing.stream;
      state.noiseContext = outgoing.context;
      state.noiseSource = outgoing.source || null;
      state.noiseNode = outgoing.noiseNode || null;
      state.noiseDestination = outgoing.destination || null;
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = true));
      const callback = (error, result) => {
        if (error || !result?.ok) {
          stopStream(state.localStream);
          void stopNoiseProcessing().catch((cleanupError) =>
            console.warn("Не удалось остановить обработку микрофона:", cleanupError),
          );
          stopStream(state.micStream);
          state.localStream = null;
          state.micStream = null;
          state.micDeviceId = "";
          notice(
            error
              ? "Сервер не ответил. Проверь подключение и попробуй ещё раз."
              : result?.error || "Не удалось подключиться.",
          );
          return;
        }
        playUiSound("join");
        enterRoom(result.code);
      };
      if (action === "create")
        socket.timeout(10000).emit("room:create", callback);
      else
        socket.timeout(10000).emit(
          "room:join",
          { code: state.pendingCode },
          callback,
        );
    } catch (e) {
      stopNoiseProcessing();
      stopStream(state.micStream);
      state.localStream = null;
      state.micStream = null;
      state.micDeviceId = "";
      notice(
        e.name === "NotAllowedError"
          ? "Разреши доступ к микрофону в настройках браузера."
          : e.message || "Не удалось включить микрофон.",
      );
    }
  }
  $("leaveRoom").onclick = exitRoom;
  socket.on("connect_error", (error) => {
    if (state.authenticated) notice(error.message || "Не удалось подключиться к серверу.");
  });
  socket.on("connect", clearNotice);
  socket.on("friends:refresh", async () => {
    try {
      const { friends } = await api("/api/friends");
      state.friends = friends;
      renderAccount();
    } catch (error) {
      notice(error.message);
    }
  });
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
    playUiSound(state.muted ? "micOff" : "micOn");
    socket.emit("member:mute", state.muted);
  };
  socket.on("room:state", ({ code, selfId, members }) => {
    state.code = code;
    state.selfId = selfId;
    state.members = new Map(members.map((m) => [m.id, m]));
    renderMembers();
    renderScreenStage();
  });
  socket.on("room:members", (members) => {
    state.members = new Map(members.map((m) => [m.id, m]));
    for (const id of state.remoteScreens.keys()) {
      if (!state.members.get(id)?.screenSharing) removeRemoteScreen(id);
    }
    renderMembers();
    renderScreenStage();
  });
  socket.on("member:joined", async (member) => {
    state.members.set(member.id, member);
    renderMembers();
    renderScreenStage();
    playUiSound("join");
    try {
      createPeer(member.id);
    } catch (e) {
      console.warn(e);
      showConnectionIssue("Не удалось подключить участника по голосу.");
    }
  });
  socket.on("member:left", ({ id }) => {
    state.members.delete(id);
    removeRemoteScreen(id);
    playUiSound("leave");
    state.peers.get(id)?.close();
    state.peers.delete(id);
    const audio = state.audioEls.get(id);
    if (audio) {
      audio.remove();
      state.audioEls.delete(id);
    }
    renderMembers();
    renderScreenStage();
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
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("memberProfileBackdrop").classList.contains("hidden"))
      closeMemberProfile();
    else if (state.screenSettingsOpen) closeScreenSettings();
    else if (state.settingsOpen) closeSettings();
    else if (!$("authBackdrop").classList.contains("hidden"))
      show($("authBackdrop"), false);
    else if (state.expandedScreenId) toggleExpandedScreen(null);
    else if (state.chatOpen) $("closeChat").click();
  });
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
      $("copyInvite").title = "Ключ скопирован";
      setTimeout(() => {
        $("copyInvite").textContent = "▢";
        $("copyInvite").title = "Скопировать ключ комнаты";
      }, 1800);
    }
  }

  $("copyInvite").onclick = copyRoomCode;
  loadAccount();
})();
