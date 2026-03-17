// ─────────────────────────────────────────────
// server.js — главный файл сервера
// ─────────────────────────────────────────────

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const QRCode     = require("qrcode");
const path       = require("path");
const { STYLES, QUESTIONS, SCALE_LABELS, MAX_SCORE } = require("./data");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT = process.env.PORT || 3000;

// ── Хранилище сессий (in-memory) ──────────────────────────────────────────
// Ключ: sessionId (строка вида "TEAM-4821")
// Значение: объект сессии
const sessions = new Map();

// ── Вспомогательные функции ───────────────────────────────────────────────

// Генерирует случайный ID сессии вида "TEAM-4821"
function generateSessionId() {
  const num = Math.floor(1000 + Math.random() * 9000);
  return "TEAM-" + num;
}

// Генерирует уникальный ID участника
function generateParticipantId() {
  return "p_" + Date.now() + "_" + Math.floor(Math.random() * 1000);
}

// Подсчитывает результаты теста по массиву ответов
// answers: [{ questionId, value }, ...]
function calcScores(answers) {
  const scores = { A: 0, D: 0, E: 0, P: 0 };
  answers.forEach(({ questionId, value }) => {
    const q = QUESTIONS.find(q => q.id === questionId);
    if (q) scores[q.style] += value;
  });

  // Сортируем стили по убыванию баллов
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  return {
    scores,
    primaryStyle:   sorted[0][0],
    secondaryStyle: sorted[1][0]
  };
}

// Удаляет сессию через 4 часа (TTL)
function scheduleSessionCleanup(sessionId) {
  setTimeout(() => {
    sessions.delete(sessionId);
    console.log("Сессия удалена по TTL:", sessionId);
  }, 4 * 60 * 60 * 1000); // 4 часа в миллисекундах
}

// ── Раздача статичных файлов ──────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json()); // чтобы читать JSON из тела запросов

// ── API: получить данные теста (вопросы + шкалу) ─────────────────────────
app.get("/api/test-data", (req, res) => {
  res.json({ questions: QUESTIONS, scaleLabels: SCALE_LABELS });
});

// ── API: получить описания стилей ─────────────────────────────────────────
app.get("/api/styles", (req, res) => {
  res.json(STYLES);
});

// ── API: создать новую сессию (тренер) ────────────────────────────────────
app.post("/api/session/create", async (req, res) => {
  const { groupName, pin } = req.body;

  // Генерируем уникальный ID
  let sessionId = generateSessionId();
  while (sessions.has(sessionId)) sessionId = generateSessionId();

  // Создаём сессию в памяти
  const session = {
    id:           sessionId,
    groupName:    groupName || "Группа",
    pin:          pin || null,
    createdAt:    Date.now(),
    participants: []           // массив участников
  };
  sessions.set(sessionId, session);
  scheduleSessionCleanup(sessionId);

  // Генерируем QR-код (ссылка на страницу участника)
  const participantUrl = `http://localhost:${PORT}/participant/?s=${sessionId}`;
  const qrDataUrl = await QRCode.toDataURL(participantUrl, { width: 300 });

  console.log("Создана сессия:", sessionId, "| Группа:", session.groupName);

  res.json({
    sessionId,
    participantUrl,
    qrDataUrl,
    trainerUrl: `http://localhost:${PORT}/trainer/?s=${sessionId}`
  });
});

// ── API: получить состояние сессии (тренер) ───────────────────────────────
app.get("/api/session/:sessionId", (req, res) => {
  const { sessionId } = req.params;
  const { pin } = req.query;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Сессия не найдена или истекла" });

  // Проверка PIN если задан
  if (session.pin && session.pin !== pin) {
    return res.status(403).json({ error: "Неверный PIN" });
  }

  res.json({
    id:           session.id,
    groupName:    session.groupName,
    createdAt:    session.createdAt,
    participants: session.participants
  });
});

// ── API: регистрация участника ────────────────────────────────────────────
app.post("/api/session/:sessionId/register", (req, res) => {
  const { sessionId } = req.params;
  const { name, role } = req.body;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Сессия не найдена или истекла" });
  if (!name || name.trim() === "") return res.status(400).json({ error: "Введи своё имя" });
  if (session.participants.length >= 15) {
    return res.status(400).json({ error: "Группа укомплектована (максимум 15 участников)" });
  }

  // Проверяем уникальность имени — если занято, добавляем номер
  let finalName = name.trim();
  const existingNames = session.participants.map(p => p.name);
  if (existingNames.includes(finalName)) {
    let counter = 2;
    while (existingNames.includes(`${finalName} ${counter}`)) counter++;
    finalName = `${finalName} ${counter}`;
  }

  const participant = {
    id:           generateParticipantId(),
    name:         finalName,
    role:         role ? role.trim() : "",
    registeredAt: Date.now(),
    completed:    false,
    answers:      [],
    scores:       null,
    primaryStyle:   null,
    secondaryStyle: null
  };

  session.participants.push(participant);

  // Уведомляем тренера в реальном времени
  io.to(sessionId).emit("participantRegistered", {
    id:        participant.id,
    name:      participant.name,
    role:      participant.role,
    completed: false
  });

  console.log(`[${sessionId}] Зарегистрирован: ${finalName}`);

  res.json({ participantId: participant.id, name: finalName });
});

// ── API: сохранить результат теста ────────────────────────────────────────
app.post("/api/session/:sessionId/submit", (req, res) => {
  const { sessionId } = req.params;
  const { participantId, answers } = req.body;
  const session = sessions.get(sessionId);

  if (!session) return res.status(404).json({ error: "Сессия не найдена" });

  const participant = session.participants.find(p => p.id === participantId);
  if (!participant) return res.status(404).json({ error: "Участник не найден" });
  if (answers.length !== QUESTIONS.length) {
    return res.status(400).json({ error: "Ответь на все вопросы" });
  }

  // Считаем результат
  const result = calcScores(answers);
  participant.answers      = answers;
  participant.completed    = true;
  participant.scores       = result.scores;
  participant.primaryStyle   = result.primaryStyle;
  participant.secondaryStyle = result.secondaryStyle;

  // Уведомляем тренера в реальном времени
  io.to(sessionId).emit("participantCompleted", {
    id:            participant.id,
    name:          participant.name,
    role:          participant.role,
    scores:        result.scores,
    primaryStyle:  result.primaryStyle,
    secondaryStyle: result.secondaryStyle
  });

  console.log(`[${sessionId}] Завершил тест: ${participant.name} → ${result.primaryStyle}`);

  res.json({
    scores:         result.scores,
    primaryStyle:   result.primaryStyle,
    secondaryStyle: result.secondaryStyle,
    maxScore:       MAX_SCORE
  });
});

// ── WebSocket: тренер подключается к сессии ───────────────────────────────
io.on("connection", (socket) => {
  // Тренер присоединяется к «комнате» своей сессии
  socket.on("joinSession", ({ sessionId }) => {
    socket.join(sessionId);
    console.log(`Тренер подключился к сессии: ${sessionId}`);
  });

  socket.on("disconnect", () => {
    console.log("Соединение закрыто:", socket.id);
  });
});

// ── Запуск сервера ────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log("─────────────────────────────────────────");
  console.log(`Сервер запущен: http://localhost:${PORT}`);
  console.log(`Тренер:         http://localhost:${PORT}/trainer/`);
  console.log("─────────────────────────────────────────");
});