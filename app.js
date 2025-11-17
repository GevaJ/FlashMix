const feedSources = [
  {
    id: "walla",
    name: "וואלה",
    url: "https://news.walla.co.il/breaking",
    parser: parseWalla,
    limit: 12,
  },
  {
    id: "ynet",
    name: "ynet",
    url: "https://www.ynet.co.il/news/category/184",
    parser: parseYnet,
    limit: 20,
  },
  {
    id: "maariv",
    name: "מעריב",
    url: "https://www.maariv.co.il/breaking-news",
    parser: parseMaariv,
    limit: 12,
  },
];

const MAX_ITEMS_PER_SOURCE = 12;
const AUTO_REFRESH_EVERY = 5 * 60 * 1000;
const PROXY_BASE = "https://api.codetabs.com/v1/proxy?quest=";
const THEME_KEY = "newsTheme";
const USER_KEY = "newsCurrentUser";

const statusEl = document.getElementById("status");
const newsListEl = document.getElementById("news-list");
const template = document.getElementById("news-item-template");
const refreshBtn = document.getElementById("refresh-btn");
const lastUpdatedEl = document.getElementById("last-updated");
const sourceCheckboxes = document.querySelectorAll("[data-source-checkbox]");
const interactions = loadInteractions();
const commentsModal = document.getElementById("comments-modal");
const modalTitleEl = commentsModal.querySelector(".modal-title");
const modalSourceEl = commentsModal.querySelector(".modal-source");
const modalListEl = commentsModal.querySelector(".modal-comment-list");
const modalForm = commentsModal.querySelector(".modal-comment-form");
const modalCloseBtn = commentsModal.querySelector(".modal-close");
const modalAuthNotice = commentsModal.querySelector(".modal-auth-notice");
const modalInput = modalForm.querySelector("input[name='comment']");
const themeToggleBtn = document.getElementById("theme-toggle");
const authAreaEl = document.getElementById("auth-area");

const relativeFormatter = new Intl.RelativeTimeFormat("he", {
  numeric: "auto",
});
const clockFormatter = new Intl.DateTimeFormat("he-IL", {
  hour: "2-digit",
  minute: "2-digit",
});
const selectedSources = new Set(feedSources.map((source) => source.id));
let latestItems = [];
let currentTheme = loadThemePreference();
applyTheme(currentTheme);
let currentUser = loadUser();
const thumbnailCache = new Map();

refreshBtn.addEventListener("click", () => refreshFeeds(true));
newsListEl.addEventListener("click", handleNewsClick);
modalForm.addEventListener("submit", handleModalCommentSubmit);
modalListEl.addEventListener("click", handleModalListClick);
modalCloseBtn.addEventListener("click", closeCommentsModal);
commentsModal.addEventListener("click", (event) => {
  if (
    event.target === commentsModal ||
    event.target.classList.contains("comments-modal__backdrop")
  ) {
    closeCommentsModal();
  }
});
themeToggleBtn.addEventListener("click", toggleTheme);
sourceCheckboxes.forEach((checkbox) => {
  checkbox.addEventListener("change", () => {
    if (checkbox.checked) {
      selectedSources.add(checkbox.value);
    } else {
      selectedSources.delete(checkbox.value);
    }
    renderNews(filterBySelection(latestItems));
  });
});

refreshFeeds();
setInterval(refreshFeeds, AUTO_REFRESH_EVERY);
renderAuthArea();

async function refreshFeeds(manual = false) {
  toggleLoading(true);
  if (manual) {
    showStatus("טוען מבזקי חדשות חיים מהאתרים המבוקשים...", "info");
  }

  try {
    const feedChunks = await Promise.all(
      feedSources.map(async (source) => {
        const htmlText = await fetchWithTimeout(
          `${PROXY_BASE}${encodeURIComponent(source.url)}`,
        );
        return source.parser(htmlText, source);
      }),
    );

    const merged = feedChunks.flat();
    const uniqueByLink = dedupeByLink(merged);

    uniqueByLink.sort((a, b) => b.date - a.date);
    latestItems = uniqueByLink;
    renderNews(filterBySelection(latestItems));
    updateLastUpdated(new Date());

    if (manual) {
      showStatus(
        `נאספו ${uniqueByLink.length} מבזקים משלושת האתרים.`,
        "success",
        true,
      );
    }
  } catch (error) {
    console.error("Feed refresh failed", error);
    renderNews([]);
    showStatus(
      "אירעה שגיאה בעת הטעינה. נסו לרענן מחדש בעוד מספר שניות.",
      "error",
    );
  } finally {
    toggleLoading(false);
  }
}

async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } finally {
    clearTimeout(id);
  }
}

function parseWalla(html, source) {
  const doc = createDocument(html);
  const sections = doc.querySelectorAll(".breaking-list section");
  const limit = source.limit ?? MAX_ITEMS_PER_SOURCE;

  return Array.from(sections)
    .map((section) => {
      const anchor = section.querySelector("a");
      const timeText = section.querySelector(".red-time")?.textContent?.trim();
      const headlineEl = section.querySelector(".breaking-item-title");
      if (!headlineEl) {
        return null;
      }

      let title = cleanupHeadline(headlineEl.textContent || "");
      if (timeText && title.startsWith(timeText)) {
        title = cleanupHeadline(title.replace(timeText, ""));
      }

      const link = absoluteUrl(source.url, anchor?.getAttribute("href"));
      const date = buildDateFromClock(timeText);

      return {
        id: `${source.id}-${link}-${date.getTime()}`,
        source: source.name,
        sourceId: source.id,
        title,
        link,
        description: "",
        date,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function parseYnet(html, source) {
  const doc = createDocument(html);
  const sections = doc.querySelectorAll(".AccordionSection");
  const limit = source.limit ?? MAX_ITEMS_PER_SOURCE;

  return Array.from(sections)
    .map((section) => {
      const title = cleanupHeadline(
        section.querySelector(".title")?.textContent || "",
      );
      if (!title) {
        return null;
      }

      const timeAttr =
        section.querySelector("time")?.getAttribute("datetime") || "";
      const date = timeAttr ? new Date(timeAttr) : new Date();

      return {
        id: `${source.id}-${timeAttr || title}`,
        source: source.name,
        sourceId: source.id,
        title,
        link: source.url,
        description: "",
        date,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function parseMaariv(html, source) {
  const doc = createDocument(html);
  const articles = doc.querySelectorAll("article.breaking-news-item");
  const limit = source.limit ?? MAX_ITEMS_PER_SOURCE;

  return Array.from(articles)
    .map((item) => {
      const title = cleanupHeadline(
        item.querySelector(".breaking-news-title")?.textContent || "",
      );
      if (!title) {
        return null;
      }

      const href = item.querySelector("a")?.getAttribute("href");
      const link = absoluteUrl(source.url, href);
      const timeAttr = item.querySelector("time")?.getAttribute("datetime");
      const date = timeAttr ? new Date(timeAttr) : new Date();
      const reporter = cleanupHeadline(
        item.querySelector(".breaking-news-reporter")?.textContent || "",
      );

      return {
        id: `${source.id}-${link}`,
        source: source.name,
        sourceId: source.id,
        title,
        link,
        description: reporter,
        date,
      };
    })
    .filter(Boolean)
    .slice(0, limit);
}

function createDocument(html) {
  return new DOMParser().parseFromString(html, "text/html");
}

function cleanupHeadline(text) {
  return text.replace(/\s+/g, " ").replace(/^[\/\s-]+/, "").trim();
}

function buildDateFromClock(clockText) {
  if (!clockText) {
    return new Date();
  }

  const [hours, minutes] = clockText.split(":").map((n) => Number(n));
  if (Number.isNaN(hours) || Number.isNaN(minutes)) {
    return new Date();
  }

  const now = new Date();
  const guess = new Date(now);
  guess.setHours(hours, minutes, 0, 0);

  // אם הזמנים "בעתיד" (למשל חצות מול ערב), נניח שזה היה אתמול.
  if (guess.getTime() - now.getTime() > 12 * 60 * 60 * 1000) {
    guess.setDate(guess.getDate() - 1);
  }

  return guess;
}

function absoluteUrl(base, href) {
  if (!href) {
    return base;
  }

  try {
    return new URL(href, base).toString();
  } catch {
    return base;
  }
}

function dedupeByLink(items) {
  const seen = new Map();
  items.forEach((item) => {
    const baseKey = `${item.sourceId || ""}-${item.id || item.title || ""}`;
    const key = item.link ? `${baseKey}-${item.link}` : baseKey;
    if (!seen.has(key)) {
      seen.set(key, item);
    }
  });
  return Array.from(seen.values());
}

function renderNews(items) {
  newsListEl.innerHTML = "";
  if (!items.length) {
    showStatus("אין מבזקים להצגה כרגע.", "info");
    return;
  }

  const fragment = document.createDocumentFragment();
  items.forEach((item) => {
    const entry = template.content.firstElementChild.cloneNode(true);
    entry.dataset.itemId = item.id;
    entry.dataset.itemTitle = item.title;
    entry.dataset.itemSource = item.source;
    entry.querySelector(".news-source").textContent = item.source;

    const timeEl = entry.querySelector(".news-time");
    timeEl.dateTime = item.date.toISOString();
    timeEl.textContent = formatTime(item.date);

    const titleEl = entry.querySelector(".news-title");
    titleEl.textContent = item.title;
    titleEl.href = item.link;

    const descriptionEl = entry.querySelector(".news-description");
    if (item.description) {
      descriptionEl.textContent = item.description;
    } else {
      descriptionEl.remove();
    }

    renderInteractions(entry, item.id);
    const thumbEl = entry.querySelector(".news-thumb");
    if (thumbEl) {
      attachThumbnail(thumbEl, item.title);
    }

    fragment.appendChild(entry);
  });

  newsListEl.appendChild(fragment);
}

function formatTime(date) {
  const relative = formatRelative(date);
  return `${clockFormatter.format(date)} · ${relative}`;
}

function formatRelative(date) {
  const diffMs = Date.now() - date.getTime();
  const seconds = Math.round(diffMs / 1000);
  const absSeconds = Math.abs(seconds);

  if (absSeconds < 60) {
    return relativeFormatter.format(-seconds, "second");
  }
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) {
    return relativeFormatter.format(-minutes, "minute");
  }
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) {
    return relativeFormatter.format(-hours, "hour");
  }
  const days = Math.round(hours / 24);
  return relativeFormatter.format(-days, "day");
}

function updateLastUpdated(date) {
  lastUpdatedEl.textContent = `עודכן ב-${clockFormatter.format(date)}`;
}

let hideStatusTimer;
function filterBySelection(items) {
  if (!selectedSources.size) {
    return [];
  }
  return items.filter((item) => selectedSources.has(item.sourceId));
}

function showStatus(message, type = "info", autoHide = false) {
  statusEl.textContent = message;
  statusEl.className = "status is-visible";
  if (type === "error") {
    statusEl.classList.add("is-error");
  } else if (type === "success") {
    statusEl.classList.add("is-success");
  }

  if (hideStatusTimer) {
    clearTimeout(hideStatusTimer);
  }

  if (autoHide) {
    hideStatusTimer = setTimeout(() => {
      statusEl.className = "status";
      statusEl.textContent = "";
    }, 4000);
  }
}

function toggleLoading(isLoading) {
  refreshBtn.disabled = isLoading;
  refreshBtn.textContent = isLoading ? "טוען..." : "רענן עכשיו";
}

function loadInteractions() {
  try {
    return JSON.parse(localStorage.getItem("newsInteractions") || "{}");
  } catch {
    return {};
  }
}

function saveInteractions() {
  localStorage.setItem("newsInteractions", JSON.stringify(interactions));
}

function ensureInteraction(itemId) {
  if (!interactions[itemId]) {
    interactions[itemId] = { likes: 0, dislikes: 0, comments: [] };
  }
  return interactions[itemId];
}

function renderInteractions(entry, itemId) {
  const state = ensureInteraction(itemId);
  entry.querySelector(".like-btn .count").textContent = state.likes;
  entry.querySelector(".dislike-btn .count").textContent = state.dislikes;
  const commentCountEl = entry.querySelector(".open-comments .comment-count");
  if (commentCountEl) {
    commentCountEl.textContent = state.comments.length;
  }
}

function handleNewsClick(event) {
  const voteButton = event.target.closest(".vote-btn");
  if (voteButton) {
    const entry = voteButton.closest(".news-item");
    if (!entry) {
      return;
    }
    const itemId = entry.dataset.itemId;
    const state = ensureInteraction(itemId);
    if (voteButton.classList.contains("like-btn")) {
      state.likes += 1;
    } else {
      state.dislikes += 1;
    }
    saveInteractions();
    renderInteractions(entry, itemId);
    return;
  }

  const commentsButton = event.target.closest(".open-comments");
  if (commentsButton) {
    const entry = commentsButton.closest(".news-item");
    if (!entry) {
      return;
    }
    openCommentsModal(entry);
  }
}

let activeCommentsItemId = null;
function openCommentsModal(entry) {
  activeCommentsItemId = entry.dataset.itemId;
  modalTitleEl.textContent = entry.dataset.itemTitle || "";
  modalSourceEl.textContent = entry.dataset.itemSource || "";
  updateModalAuthState();
  renderCommentsModal();
  commentsModal.hidden = false;
  commentsModal.classList.add("is-visible");
}

function closeCommentsModal() {
  commentsModal.classList.remove("is-visible");
  commentsModal.hidden = true;
  activeCommentsItemId = null;
  modalInput.value = "";
}

function renderCommentsModal() {
  if (!activeCommentsItemId) {
    return;
  }
  const state = ensureInteraction(activeCommentsItemId);
  modalListEl.innerHTML = "";
  state.comments.forEach((comment) => {
    comment.likes = comment.likes ?? 0;
    comment.dislikes = comment.dislikes ?? 0;
    comment.voters = comment.voters ?? {};
    const li = document.createElement("li");
    li.className = "modal-comment-item";
    const commentId =
      comment.id ||
      `${comment.userId || "guest"}-${comment.ts || Date.now()}-${Math.random()
        .toString(16)
        .slice(2)}`;
    comment.id = commentId;
    li.dataset.commentId = commentId;
    const body = document.createElement("div");
    body.className = "comment-body";
    const author = document.createElement("strong");
    author.textContent = comment.userName || "אורח";
    const textNode = document.createElement("span");
    textNode.textContent = comment.text;
    body.appendChild(author);
    body.appendChild(document.createElement("br"));
    body.appendChild(textNode);
    const votes = document.createElement("div");
    votes.className = "comment-votes";
    votes.innerHTML = `
      <button type="button" class="comment-vote" data-comment-id="${commentId}" data-action="like">
        👍 <span class="count">${comment.likes}</span>
      </button>
      <button type="button" class="comment-vote" data-comment-id="${commentId}" data-action="dislike">
        👎 <span class="count">${comment.dislikes}</span>
      </button>
    `;
    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "comment-delete";
    deleteBtn.dataset.commentId = commentId;
    deleteBtn.textContent = "מחק";
    deleteBtn.hidden = !currentUser || comment.userId !== currentUser.id;
    li.appendChild(body);
    li.appendChild(votes);
    li.appendChild(deleteBtn);
    modalListEl.appendChild(li);
  });
}

function handleModalCommentSubmit(event) {
  event.preventDefault();
  if (!currentUser) {
    updateModalAuthState();
    return;
  }
  if (!activeCommentsItemId) {
    return;
  }
  const text = modalInput.value.trim();
  if (!text) {
    return;
  }
  const state = ensureInteraction(activeCommentsItemId);
  state.comments.unshift({
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    text,
    userId: currentUser.id,
    userName: currentUser.name,
    userAvatar: currentUser.picture || "",
    ts: Date.now(),
  });
  state.comments = state.comments.slice(0, 30);
  saveInteractions();
  modalInput.value = "";
  renderCommentsModal();
  updateCommentCount(activeCommentsItemId);
}

function handleModalListClick(event) {
  const deleteBtn = event.target.closest(".comment-delete");
  if (deleteBtn && activeCommentsItemId) {
    const commentId = deleteBtn.dataset.commentId;
    const state = ensureInteraction(activeCommentsItemId);
    const targetComment = state.comments.find(
      (comment) => comment.id === commentId,
    );
    if (
      !targetComment ||
      !currentUser ||
      targetComment.userId !== currentUser.id
    ) {
      return;
    }
    state.comments = state.comments.filter(
      (comment) => comment.id !== commentId,
    );
    saveInteractions();
    renderCommentsModal();
    updateCommentCount(activeCommentsItemId);
    return;
  }

  const voteBtn = event.target.closest(".comment-vote");
  if (voteBtn) {
    if (!currentUser || !activeCommentsItemId) {
      updateModalAuthState();
      return;
    }
    const action = voteBtn.dataset.action;
    const commentId = voteBtn.dataset.commentId;
    handleCommentVote(commentId, action);
  }
}

function handleCommentVote(commentId, action) {
  const state = ensureInteraction(activeCommentsItemId);
  const comment = state.comments.find((item) => item.id === commentId);
  if (!comment) {
    return;
  }
  comment.likes = comment.likes ?? 0;
  comment.dislikes = comment.dislikes ?? 0;
  comment.voters = comment.voters ?? {};
  const previous = comment.voters[currentUser.id];
  if (previous === action) {
    return;
  }
  if (previous === "like") {
    comment.likes = Math.max(0, comment.likes - 1);
  } else if (previous === "dislike") {
    comment.dislikes = Math.max(0, comment.dislikes - 1);
  }
  if (action === "like") {
    comment.likes += 1;
  } else if (action === "dislike") {
    comment.dislikes += 1;
  }
  comment.voters[currentUser.id] = action;
  saveInteractions();
  renderCommentsModal();
}

function updateCommentCount(itemId) {
  const entry = Array.from(newsListEl.querySelectorAll(".news-item")).find(
    (el) => el.dataset.itemId === itemId,
  );
  if (entry) {
    renderInteractions(entry, itemId);
  }
}

function loadThemePreference() {
  return localStorage.getItem(THEME_KEY) || "light";
}

function applyTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
  if (themeToggleBtn) {
    themeToggleBtn.textContent = theme === "dark" ? "☀️" : "🌙";
  }
}

function toggleTheme() {
  currentTheme = currentTheme === "dark" ? "light" : "dark";
  localStorage.setItem(THEME_KEY, currentTheme);
  applyTheme(currentTheme);
  renderAuthArea();
}

function loadUser() {
  try {
    return JSON.parse(localStorage.getItem(USER_KEY) || "null");
  } catch {
    return null;
  }
}

function saveUser() {
  if (currentUser) {
    localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
  } else {
    localStorage.removeItem(USER_KEY);
  }
}

function renderAuthArea() {
  if (!authAreaEl) {
    return;
  }
  if (currentUser) {
    authAreaEl.innerHTML = `
      <div class="user-chip">
        ${
          currentUser.picture
            ? `<img src="${currentUser.picture}" alt="${currentUser.name}">`
            : ""
        }
        <span>${currentUser.name}</span>
        <button type="button" class="signout-btn">Logout</button>
      </div>
    `;
    const logoutBtn = authAreaEl.querySelector(".signout-btn");
    logoutBtn.addEventListener("click", handleSignOut);
  } else {
    authAreaEl.innerHTML = `
      <form id="login-form" class="login-form">
        <input
          type="text"
          name="nickname"
          placeholder="כינוי"
          autocomplete="nickname"
          required
        />
        <button type="submit">כניסה</button>
      </form>
      <p class="auth-hint">בחרו כינוי כדי להוסיף תגובות.</p>
    `;
    const loginFormEl = authAreaEl.querySelector("#login-form");
    if (loginFormEl) {
      loginFormEl.addEventListener("submit", handleLoginSubmit);
    }
  }
  updateModalAuthState();
}

function handleSignOut() {
  currentUser = null;
  saveUser();
  renderAuthArea();
}

function updateModalAuthState() {
  if (!modalForm) {
    return;
  }
  if (currentUser) {
    modalForm.hidden = false;
    modalInput.disabled = false;
    modalAuthNotice.hidden = true;
  } else {
    modalForm.hidden = true;
    modalInput.disabled = true;
    modalAuthNotice.hidden = false;
  }
}

function handleLoginSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const nickname = form.nickname.value.trim();
  if (!nickname) {
    return;
  }
  currentUser = {
    id: `local:${nickname.toLowerCase()}`,
    name: nickname,
    handle: nickname,
    picture: "",
  };
  form.reset();
  saveUser();
  renderAuthArea();
}

function attachThumbnail(container, title) {
  fetchThumbnailForTitle(title)
    .then((src) => {
      if (!src) {
        container.hidden = true;
        return;
      }
      const img = container.querySelector("img");
      img.src = src;
      img.alt = `תמונה עבור ${title}`;
      container.hidden = false;
    })
    .catch(() => {
      container.hidden = true;
    });
}

function fetchThumbnailForTitle(title) {
  if (thumbnailCache.has(title)) {
    return thumbnailCache.get(title);
  }
  const promise = (async () => {
    try {
      const googleUrl = `https://www.google.com/search?tbm=isch&q=${encodeURIComponent(
        title,
      )}`;
      const proxiedUrl = `${PROXY_BASE}${encodeURIComponent(googleUrl)}`;
      const response = await fetch(proxiedUrl);
      if (!response.ok) {
        throw new Error("image fetch failed");
      }
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const candidate = Array.from(doc.querySelectorAll("img")).find((img) => {
        const src = img.getAttribute("src") || "";
        return /^https?:/.test(src);
      });
      if (candidate) {
        return candidate.getAttribute("src");
      }
    } catch (error) {
      console.warn("thumbnail fetch error", error);
    }
    return "";
  })();
  thumbnailCache.set(title, promise);
  return promise;
}
