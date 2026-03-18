const CURSOR_COLORS = [
  "#f44336",
  "#2196f3",
  "#4caf50",
  "#ff9800",
  "#9c27b0",
  "#00bcd4",
  "#e91e63",
  "#8bc34a",
];

const STORAGE_KEY = "pokapali:user";

export interface StoredUser {
  name: string;
  color: string;
}

export function loadUser(): StoredUser {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.name && parsed.color) return parsed;
    }
  } catch {
    // localStorage unavailable
  }
  const color =
    CURSOR_COLORS[Math.floor(Math.random() * CURSOR_COLORS.length)]!;
  return { name: "", color };
}

export function saveUser(user: StoredUser) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(user));
  } catch {
    // localStorage unavailable
  }
}

export function renderCursor(user: { name: string; color: string }) {
  const el = document.createElement("span");
  el.classList.add("collab-cursor");
  el.style.borderColor = user.color;

  const label = document.createElement("span");
  label.classList.add("collab-cursor-label");
  label.style.background = user.color;
  label.textContent = user.name;
  el.appendChild(label);

  return el;
}
