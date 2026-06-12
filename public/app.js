const state = {
  user: null,
  runtime: null,
  deviceId: localStorage.getItem("moviejavan_device_id") || crypto.randomUUID()
};

localStorage.setItem("moviejavan_device_id", state.deviceId);

const $ = (selector) => document.querySelector(selector);
const status = $("#status");
const serverLabel = $("#serverLabel");
const playstoreFrame = $("#playstoreFrame");
const openPlaystore = $("#openPlaystore");
const devicesButton = $("#devicesButton");
const deviceDrawer = $("#deviceDrawer");
const deviceList = $("#deviceList");
const shell = $(".shell");
const closeAuthPanel = $("#closeAuthPanel");
const openAuthPanel = $("#openAuthPanel");
const logsButton = $("#logsButton");
const logDrawer = $("#logDrawer");
const logOutput = $("#logOutput");
const refreshLogs = $("#refreshLogs");
const copyLogs = $("#copyLogs");
const clearLogs = $("#clearLogs");
const closeLogs = $("#closeLogs");

const appPathPrefixes = [
  "/movie",
  "/movies",
  "/series",
  "/episode",
  "/genre",
  "/actor",
  "/director",
  "/search",
  "/category",
  "/anime",
  "/kids",
  "/login",
  "/user",
  "/profile",
  "/subscription"
];

function shouldProxyPath(pathname) {
  return appPathPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

function normalizeAppUrl(value) {
  const url = new URL(value, window.location.origin);
  if (url.pathname.startsWith("/app/")) return `${url.pathname}${url.search}${url.hash}`;
  if (url.pathname === "/playstore" || url.pathname.startsWith("/playstore/")) {
    return `/app${url.pathname}${url.search}${url.hash}`;
  }
  if (shouldProxyPath(url.pathname)) {
    return `/app/playstore${url.pathname}${url.search}${url.hash}`;
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.style.color = isError ? "#ff8c8c" : "#d8dee8";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "خطا در ارتباط با سرور");
  return payload;
}

async function sendClientLog(payload) {
  try {
    await fetch("/api/client-log", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch {
  }
}

function formJson(form) {
  return Object.fromEntries(new FormData(form).entries());
}

function activateTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });
  document.querySelectorAll(".form").forEach((form) => {
    form.classList.toggle("active", form.id === `${name}Form`);
  });
}

function renderUser(user) {
  state.user = user;
  $("#userName").textContent = user?.name || user?.email || "کاربر وارد شده";
  $("#subscription").textContent =
    user?.substatus === "active"
      ? `اشتراک فعال${user.package_title ? ` - ${user.package_title}` : ""}`
      : "اشتراک فعال نیست یا اطلاعات اشتراک دریافت نشد";
  devicesButton.disabled = !user?.user_id;
}

function setPlaystore(url) {
  const normalizedUrl = normalizeAppUrl(url);
  openPlaystore.href = normalizedUrl;
  playstoreFrame.src = normalizedUrl;
}

function setAuthPanelCollapsed(collapsed) {
  shell.classList.toggle("auth-collapsed", collapsed);
  openAuthPanel.hidden = !collapsed;
  localStorage.setItem("moviejavan_auth_collapsed", collapsed ? "1" : "0");
}

async function loadLogs() {
  const data = await api("/api/logs");
  logOutput.textContent = JSON.stringify(data.logs || [], null, 2);
}

async function loadRuntime() {
  state.runtime = await api("/api/runtime");
  serverLabel.textContent = state.runtime.domain;
  setPlaystore(state.runtime.playstoreUrl);
}

async function loadConfig() {
  try {
    const appConfig = await api("/api/config");
    if (appConfig?.PaidUserDomain && state.user?.substatus === "active") setStatus("دامنه کاربران ویژه فعال شد.");
  } catch (error) {
    console.warn(error);
  }
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => activateTab(tab.dataset.tab));
});

closeAuthPanel.addEventListener("click", () => setAuthPanelCollapsed(true));
openAuthPanel.addEventListener("click", () => setAuthPanelCollapsed(false));
logsButton.addEventListener("click", async () => {
  logDrawer.hidden = false;
  await loadLogs();
});
refreshLogs.addEventListener("click", loadLogs);
copyLogs.addEventListener("click", async () => {
  await navigator.clipboard.writeText(logOutput.textContent || "");
});
clearLogs.addEventListener("click", async () => {
  await api("/api/logs/clear", { method: "POST", body: "{}" });
  await loadLogs();
});
closeLogs.addEventListener("click", () => {
  logDrawer.hidden = true;
});

playstoreFrame.addEventListener("load", () => {
  try {
    const frameUrl = new URL(playstoreFrame.contentWindow.location.href);
    sendClientLog({ kind: "iframe-load", url: frameUrl.href });
    if (shouldProxyPath(frameUrl.pathname) || frameUrl.pathname === "/playstore" || frameUrl.pathname.startsWith("/playstore/")) {
      const normalizedUrl = normalizeAppUrl(`${frameUrl.pathname}${frameUrl.search}${frameUrl.hash}`);
      if (normalizedUrl !== `${frameUrl.pathname}${frameUrl.search}${frameUrl.hash}`) setPlaystore(normalizedUrl);
    }
  } catch (error) {
    sendClientLog({ kind: "iframe-load-error", message: error.message, src: playstoreFrame.src });
    // Cross-origin frames are not expected after proxying, but no action is needed if one appears.
  }
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("در حال ورود...");
  try {
    const payload = {
      ...formJson(event.currentTarget),
      deviceId: state.deviceId,
      deviceModel: navigator.userAgent
    };
    const user = await api("/api/login", {
      method: "POST",
      body: JSON.stringify(payload)
    });

    if (user.status === "error") {
      setStatus(user.data || "ایمیل یا رمز عبور صحیح نیست.", true);
      return;
    }

    renderUser(user);
    await loadConfig();
    setPlaystore("/app/playstore/user/do_login_windows");
    localStorage.setItem("moviejavan_user", JSON.stringify(user));
    setStatus("ورود انجام شد. اگر محتوای برنامه داخل صفحه نمایش داده نشد، از دکمه باز کردن برنامه استفاده کنید.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

$("#signupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("در حال ساخت حساب...");
  try {
    const result = await api("/api/signup", {
      method: "POST",
      body: JSON.stringify(formJson(event.currentTarget))
    });
    if (result.status === "error") {
      setStatus(result.data || "ثبت نام انجام نشد.", true);
      return;
    }
    setStatus("حساب ساخته شد. حالا از بخش ورود وارد شوید.");
    activateTab("login");
  } catch (error) {
    setStatus(error.message, true);
  }
});

$("#forgotForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("در حال ارسال درخواست...");
  try {
    const result = await api("/api/forgot-password", {
      method: "POST",
      body: JSON.stringify(formJson(event.currentTarget))
    });
    setStatus(typeof result === "string" ? result : "درخواست بازیابی ارسال شد.");
  } catch (error) {
    setStatus(error.message, true);
  }
});

devicesButton.addEventListener("click", async () => {
  if (!state.user?.user_id) return;
  deviceDrawer.hidden = false;
  deviceList.innerHTML = "<p>در حال دریافت دستگاه‌ها...</p>";
  try {
    const devices = await api("/api/devices", {
      method: "POST",
      body: JSON.stringify({ userId: state.user.user_id })
    });
    const list = Array.isArray(devices) ? devices : [];
    deviceList.innerHTML = "";
    if (!list.length) {
      deviceList.innerHTML = "<p>دستگاهی پیدا نشد.</p>";
      return;
    }

    for (const device of list) {
      const item = document.createElement("div");
      item.className = "device-item";
      item.innerHTML = `
        <div>
          <strong>${device.type || "Device"}</strong>
          <span>${device.description || ""} ${device.last_login || ""}</span>
        </div>
        <button type="button">غیرفعال کردن</button>
      `;
      item.querySelector("button").addEventListener("click", async () => {
        await api("/api/devices/deactivate", {
          method: "POST",
          body: JSON.stringify({ id: device.id, mode: "id" })
        });
        item.remove();
      });
      deviceList.append(item);
    }
  } catch (error) {
    deviceList.innerHTML = `<p>${error.message}</p>`;
  }
});

$("#closeDevices").addEventListener("click", () => {
  deviceDrawer.hidden = true;
});

const cachedUser = localStorage.getItem("moviejavan_user");
if (cachedUser) {
  try {
    renderUser(JSON.parse(cachedUser));
  } catch {
    localStorage.removeItem("moviejavan_user");
  }
}

await loadRuntime();
await loadConfig();
setAuthPanelCollapsed(localStorage.getItem("moviejavan_auth_collapsed") === "1");
