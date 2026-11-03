import "./style.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type ViewMode = "single" | "strip";
type ScaleMode = "actual" | "fit-width" | "fit-height" | "custom";

interface ViewerPayload {
  currentPath: string | null;
  directory: string | null;
  images: string[];
  supportedExtensions: string[];
}

interface ImageCacheEntry {
  src: string;
  loadedAt: number;
}

interface AssociationResult {
  platform: string;
  message: string;
  requiresManualConfirmation: boolean;
}

const STRIP_TOGGLE_KEY = "Tab";
const PRELOAD_DISTANCE = 2;
const CACHE_LIMIT = 12;
const TOUCHPAD_PINCH_ZOOM_SENSITIVITY = 0.006;
const CTRL_MOUSE_WHEEL_ZOOM_SENSITIVITY = 0.001;
const MOUSE_WHEEL_DELTA_STEP = 50;
const IMAGE_EXTENSION_PATTERN =
  /\.(jpg|jpeg|png|bmp|gif|webp|tif|tiff|ico|heic|svg)$/i;

class ViewerApp {
  private root = document.querySelector<HTMLDivElement>("#app")!;
  private payload: ViewerPayload | null = null;
  private currentIndex = 0;
  private mode: ViewMode = "single";
  private scaleMode: ScaleMode = "actual";
  private scale = 1;
  private cache = new Map<string, ImageCacheEntry>();
  private renderedStrip = new Set<string>();
  private loadingStrip = new Set<string>();
  private singleImageNaturalWidth = 0;
  private singleImageNaturalHeight = 0;
  private stripScrollFrame = 0;
  private pinchDistance: number | null = null;
  private pinchBaseScale = 1;
  private pinchBasePan = { x: 0, y: 0 };
  private pinchCenter: { x: number; y: number } | null = null;
  private appWindow = getCurrentWindow();
  private lastWheelZoomAt = 0;
  private lastWheelNavTime = 0;
  private lastWheelDebugAt = 0;
  private wheelAccumulatorY = 0;
  private wheelResetTimer: number | null = null;
  private lastPointerPoint: { x: number; y: number } | null = null;
  private isPanningImage = false;
  private panStartPoint = { x: 0, y: 0 };
  private panBaseOffset = { x: 0, y: 0 };
  private dragPointerId: number | null = null;
  private dragStartPoint: { x: number; y: number } | null = null;
  private dragTriggered = false;
  private stripObserver: IntersectionObserver | null = null;
  private stripLoadQueue: number[] = [];
  private stripActiveLoads = 0;
  private maxConcurrentStripLoads = 4;
  private stripWidthPercent = 100;
  private isPresentationMode = false;
  private panX = 0;
  private panY = 0;
  private contextMenuElement: HTMLDivElement | null = null;
  private contextMenuTarget: string | null = null;
  private statusNotice: string | null = null;
  private statusNoticeTimer: number | null = null;
  private toastElement: HTMLDivElement | null = null;
  private toastTimer: number | null = null;

  async init() {
    this.renderShell();
    this.bindNativeBridges();
    this.attachGlobalEvents();

    try {
      await this.refreshWindowChrome();
      void this.debugLog("init", "refreshWindowChrome:ok");
      this.payload = await invoke<ViewerPayload>("get_startup_payload");
      void this.debugLog("startup-payload", JSON.stringify(this.payload));
      if (!this.payload.images.length) {
        this.renderEmpty("把图片拖进窗口，或从右键菜单 / 文件关联直接打开。");
        return;
      }

      this.currentIndex = Math.max(
        0,
        this.payload.images.findIndex((path) => path === this.payload?.currentPath)
      );

      await this.renderSingleView(true);
      this.preloadNearby();
    } catch (error) {
      void this.debugLog("init-error", String(error));
      this.renderEmpty(`启动失败：${String(error)}`);
    }
  }

  private bindNativeBridges() {
    interface SeeWindow extends Window {
      __SEE_SYNC_PRESENTATION_MODE__?: (enabled: boolean) => void;
      __SEE_OPEN_DROPPED_PATHS__?: (paths: string[]) => void;
    }
    const win = window as SeeWindow;
    win.__SEE_SYNC_PRESENTATION_MODE__ = (enabled: boolean) => {
      this.applyFullscreenChrome(Boolean(enabled));
    };
    win.__SEE_OPEN_DROPPED_PATHS__ = (paths: string[]) => {
      void this.handleNativeDropPaths(paths);
    };
  }

  private renderShell() {
    this.root.innerHTML = `
      <div class="app-shell">
        <header class="topbar">
          <div class="topbar__drag" id="drag-surface">
            <div class="topbar__meta">
              <span class="topbar__title">See</span>
              <span class="topbar__path" id="current-path"></span>
            </div>
          </div>
          <div class="topbar__actions">
            <button class="ghost-button" id="default-app" title="注册图片关联并打开系统设置">设为默认</button>
            <button class="ghost-button" id="mode-toggle" title="Tab">长页模式</button>
            <div class="window-controls">
              <button class="window-button" id="window-minimize" title="最小化">_</button>
              <button class="window-button" id="window-maximize" title="最大化">□</button>
              <button class="window-button window-button--close" id="window-close" title="关闭">×</button>
            </div>
          </div>
        </header>
        <main class="viewport" id="viewport"></main>
        <footer class="statusbar" id="statusbar"></footer>
      </div>
    `;

    this.root
      .querySelector<HTMLDivElement>("#drag-surface")!
      .addEventListener("pointerdown", this.handleDragPointerDown);

    this.root
      .querySelector<HTMLDivElement>("#drag-surface")!
      .addEventListener("pointermove", this.handleDragPointerMove);

    this.root
      .querySelector<HTMLDivElement>("#drag-surface")!
      .addEventListener("pointerup", this.handleDragPointerEnd);

    this.root
      .querySelector<HTMLDivElement>("#drag-surface")!
      .addEventListener("pointercancel", this.handleDragPointerEnd);

    this.root
      .querySelector<HTMLDivElement>("#drag-surface")!
      .addEventListener("dblclick", () => {
        void this.toggleMaximize();
      });

    this.root.querySelector<HTMLButtonElement>("#mode-toggle")!.addEventListener("click", () => {
      void this.toggleMode();
    });

    this.root.querySelector<HTMLButtonElement>("#default-app")!.addEventListener("click", () => {
      void this.prepareDefaultApp();
    });

    this.root.querySelector<HTMLButtonElement>("#window-minimize")!.addEventListener("click", () => {
      void invoke("minimize_window");
    });

    this.root.querySelector<HTMLButtonElement>("#window-maximize")!.addEventListener("click", () => {
      void this.toggleMaximize();
    });

    this.root.querySelector<HTMLButtonElement>("#window-close")!.addEventListener("click", () => {
      void invoke("close_window");
    });
  }

  private attachGlobalEvents() {
    void this.appWindow
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") {
          return;
        }

        const firstImagePath = event.payload.paths.find((path) => IMAGE_EXTENSION_PATTERN.test(path));
        void this.debugLog("window-drop", JSON.stringify(event.payload.paths));
        if (!firstImagePath) {
          this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent =
            "拖入的文件里没有可打开的图片格式。";
          return;
        }

        void this.openPath(firstImagePath);
      })
      .catch((error) => {
        void this.debugLog("window-drop-listener-error", String(error));
      });

    void this.appWindow
      .listen<{ paths: string[] }>("see://native-drop", (event) => {
        void this.handleNativeDropPaths(event.payload.paths);
      })
      .catch((error) => {
        void this.debugLog("native-drop-listener-error", String(error));
      });

    window.addEventListener(
      "dragover",
      this.handleDomDragOver,
      { passive: false }
    );

    window.addEventListener(
      "drop",
      this.handleDomDrop,
      { passive: false }
    );

    window.addEventListener("keydown", (event) => {
      if (event.key === "F11") {
        event.preventDefault();
        void this.toggleFullscreen();
        return;
      }

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "w") {
        event.preventDefault();
        void invoke("close_window");
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        if (this.isContextMenuOpen()) {
          this.closeContextMenu();
          return;
        }
        if (this.isPresentationMode) {
          void this.toggleFullscreen();
        } else if (this.mode === "strip" && this.payload?.images.length) {
          this.mode = "single";
          void this.renderSingleView(false);
        } else {
          void invoke("close_window");
        }
        return;
      }

      if (!this.payload?.images.length) {
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        this.closeContextMenu();
        const current = this.currentPath();
        if (current) {
          void this.deleteImage(current, event.shiftKey);
        }
        return;
      }

      if (event.key === STRIP_TOGGLE_KEY) {
        event.preventDefault();
        void this.toggleMode();
        return;
      }

      if (this.mode === "single") {
        if (event.key === "ArrowLeft" || event.key === "ArrowUp" || event.key === "PageUp") {
          event.preventDefault();
          void this.stepSingleImage(-1);
        } else if (event.key === "ArrowRight" || event.key === "ArrowDown" || event.key === "PageDown" || event.key === " ") {
          event.preventDefault();
          void this.stepSingleImage(1);
        } else if (event.key === "Home") {
          event.preventDefault();
          void this.goToIndex(0);
        } else if (event.key === "End") {
          event.preventDefault();
          void this.goToIndex((this.payload?.images.length ?? 1) - 1);
        } else if (event.key === "0") {
          event.preventDefault();
          this.resetSingleScaleToLongSide();
        } else if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          this.applyZoom(this.getCurrentSingleScale() * 1.1);
        } else if (event.key === "-") {
          event.preventDefault();
          this.applyZoom(this.getCurrentSingleScale() * 0.9);
        }
      }
    });

    window.addEventListener(
      "wheel",
      (event) => {
        this.closeContextMenu();

        if (event.ctrlKey || event.metaKey) {
          if (this.mode === "single") {
            event.preventDefault();
            this.applyWheelZoom(event);
          }
          return;
        }

        if (this.mode === "single") {
          event.preventDefault();
          this.handleSingleWheelNavigate(event);
        }
      },
      { passive: false }
    );

    window.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.handleContextMenu(event);
    });

    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.button === 2) {
          // 右键点击由 contextmenu 事件处理，不在这里关闭
          return;
        }
        if (this.contextMenuElement && !this.contextMenuElement.contains(event.target as Node)) {
          this.closeContextMenu();
        }
      },
      { capture: true }
    );

    window.addEventListener("resize", this.closeContextMenu);
    window.addEventListener("resize", this.handleWindowResize, { passive: true });

    void this.appWindow.onResized(() => {
      void this.refreshWindowChrome();
    });

    void this.appWindow
      .listen<boolean>("see://presentation-mode", (event) => {
        this.applyFullscreenChrome(Boolean(event.payload));
      })
      .catch((error) => {
        void this.debugLog("presentation-listener-error", String(error));
      });
  }

  private async openPath(path: string) {
    this.closeContextMenu();
    try {
      const normalizedPath = this.normalizeInputPath(path);
      if (!normalizedPath) {
        throw new Error("拖入内容里没有可用的图片路径");
      }

      this.payload = await invoke<ViewerPayload>("get_payload_for_path", { path: normalizedPath });
      void this.debugLog(
        "open-path",
        JSON.stringify({ path, normalizedPath, currentPath: this.payload.currentPath })
      );
      if (!this.payload.images.length) {
        this.renderEmpty("拖入的路径没有找到可显示的图片。");
        return;
      }

      this.currentIndex = Math.max(
        0,
        this.payload.images.findIndex((item) => item === this.payload?.currentPath)
      );
      this.mode = "single";
      this.cache.clear();
      this.renderedStrip.clear();
      this.loadingStrip.clear();
      await this.renderSingleView(true);
      this.preloadNearby();
    } catch (error) {
      void this.debugLog("open-path-error", JSON.stringify({ path, error: String(error) }));
      this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent = `打开拖入图片失败：${String(error)}`;
    }
  }

  private async toggleMode() {
    this.closeContextMenu();
    this.mode = this.mode === "single" ? "strip" : "single";
    void this.debugLog("toggle-mode", `mode=${this.mode}`);

    if (this.mode === "single") {
      if (this.stripObserver) {
        this.stripObserver.disconnect();
        this.stripObserver = null;
      }
      this.stripLoadQueue = [];
      await this.renderSingleView(false);
      return;
    }

    await this.renderStripView();
  }

  private async stepSingleImage(step: number) {
    if (!this.payload || !this.payload.images.length) {
      return;
    }

    const total = this.payload.images.length;
    if (total <= 1) {
      return;
    }

    const targetIndex = this.currentIndex + step;

    if (targetIndex >= total) {
      this.showToast(`已是最后一张图片 (${total}/${total})`, 1200);
      return;
    }

    if (targetIndex < 0) {
      this.showToast(`已是第一张图片 (1/${total})`, 1200);
      return;
    }

    await this.goToIndex(targetIndex);
  }

  private handleSingleWheelNavigate(event: WheelEvent) {
    this.logWheelShape(event);
    if (!this.payload || this.payload.images.length <= 1) {
      return;
    }

    const now = performance.now();
    if (now - this.lastWheelNavTime < 160) {
      return;
    }

    const deltaY = event.deltaY;
    if (deltaY === 0) {
      return;
    }

    const isDiscreteNotch = event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL || Math.abs(deltaY) >= 28;

    if (isDiscreteNotch) {
      this.wheelAccumulatorY = 0;
      this.lastWheelNavTime = now;
      const step = deltaY > 0 ? 1 : -1;
      void this.stepSingleImage(step);
      return;
    }

    this.wheelAccumulatorY += deltaY;

    if (this.wheelResetTimer) {
      window.clearTimeout(this.wheelResetTimer);
    }
    this.wheelResetTimer = window.setTimeout(() => {
      this.wheelAccumulatorY = 0;
    }, 200);

    if (Math.abs(this.wheelAccumulatorY) >= 40) {
      const step = this.wheelAccumulatorY > 0 ? 1 : -1;
      this.wheelAccumulatorY = 0;
      this.lastWheelNavTime = now;
      void this.stepSingleImage(step);
    }
  }

  private async goToIndex(nextIndex: number) {
    this.closeContextMenu();
    if (!this.payload) {
      return;
    }

    const boundedIndex = Math.min(Math.max(nextIndex, 0), this.payload.images.length - 1);
    void this.debugLog("go-to-index", JSON.stringify({ from: this.currentIndex, to: boundedIndex }));
    if (boundedIndex === this.currentIndex) {
      return;
    }

    this.currentIndex = boundedIndex;

    if (this.mode === "single") {
      await this.renderSingleView(true);
    } else {
      this.syncStripViewport();
    }

    this.preloadNearby();
  }

  private async renderSingleView(resetScale: boolean) {
    this.isPanningImage = false;
    const viewport = this.getViewport();
    const imagePath = this.currentPath();
    if (!imagePath) {
      this.renderEmpty("没有可显示的图片。");
      return;
    }

    viewport.innerHTML = `
      <section class="single-view">
        <div class="single-stage" id="single-stage">
          <img class="single-image is-loading" id="single-image" alt="" draggable="false" />
        </div>
      </section>
    `;

    const stage = viewport.querySelector<HTMLDivElement>("#single-stage")!;
    const image = viewport.querySelector<HTMLImageElement>("#single-image")!;
    const imageSrc = await this.loadImageSource(imagePath);
    void this.debugLog("render-single", JSON.stringify({ imagePath, sourceKind: imageSrc.slice(0, 24) }));

    if (resetScale) {
      this.scaleMode = "actual";
      this.scale = 1;
      this.resetPan();
      image.style.width = "";
      image.style.height = "";
      image.style.transform = "none";
    }

    const applyLoadedLayout = () => {
      this.singleImageNaturalWidth = image.naturalWidth;
      this.singleImageNaturalHeight = image.naturalHeight;

      if (resetScale) {
        const availableWidth = this.getAvailableSingleImageWidth();
        const availableHeight = this.getAvailableSingleImageHeight();
        const fitsWithoutScaling =
          this.singleImageNaturalWidth <= availableWidth && this.singleImageNaturalHeight <= availableHeight;

        if (fitsWithoutScaling) {
          this.scaleMode = "actual";
        } else {
          // 模拟 object-fit:contain：先试 fit-width，计算缩放后的渲染高度
          // 若仍超出可用高度则改用 fit-height，确保图片完整显示不溢出
          const heightIfFitWidth =
            this.singleImageNaturalHeight * (availableWidth / this.singleImageNaturalWidth);
          // 减去 1px 容差，防止浏览器浮点精度/亚像素渲染导致高度溢出一点点
          this.scaleMode = heightIfFitWidth <= availableHeight - 1 ? "fit-width" : "fit-height";
        }
        this.scale = 1;
      }

      requestAnimationFrame(() => {
        this.applySingleImageTransform();
        image.classList.remove("is-loading");
        this.updateStatus();
        this.updateTitle();
      });
    };

    image.onerror = () => {
      this.handleSingleImageError(imagePath);
    };
    image.onload = applyLoadedLayout;
    image.src = imageSrc;
    if (image.complete) {
      applyLoadedLayout();
    }

    stage.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (!this.canCurrentSingleImagePan()) return;

      this.isPanningImage = true;
      stage.classList.add("is-panning");
      this.panStartPoint = { x: event.clientX, y: event.clientY };
      this.panBaseOffset = { x: this.panX, y: this.panY };
      stage.setPointerCapture(event.pointerId);
    });

    stage.addEventListener(
      "pointermove",
      (event) => {
        this.lastPointerPoint = { x: event.clientX, y: event.clientY };
        if (!this.isPanningImage) return;

        this.panX = this.panBaseOffset.x + (event.clientX - this.panStartPoint.x);
        this.panY = this.panBaseOffset.y + (event.clientY - this.panStartPoint.y);
        this.applySingleImageTransform();
      },
      { passive: true }
    );

    const stopImagePan = (event: PointerEvent) => {
      if (!this.isPanningImage) return;
      this.isPanningImage = false;
      stage.classList.remove("is-panning");
      try {
        stage.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore pointer capture errors
      }
    };

    stage.addEventListener("pointerup", stopImagePan);
    stage.addEventListener("pointercancel", stopImagePan);

    stage.addEventListener("dblclick", () => {
      this.resetSingleScaleToLongSide();
    });

    stage.addEventListener("touchstart", (event) => {
      if (event.touches.length !== 2) {
        this.pinchDistance = null;
        return;
      }

      this.pinchDistance = this.getTouchDistance(event.touches[0], event.touches[1]);
      this.pinchBaseScale = this.getCurrentSingleScale();
      this.pinchBasePan = { x: this.panX, y: this.panY };
      this.pinchCenter = this.getTouchCenter(event.touches[0], event.touches[1]);
    });

    stage.addEventListener(
      "touchmove",
      (event) => {
        if (event.touches.length !== 2 || this.pinchDistance === null) {
          return;
        }

        event.preventDefault();
        const nextDistance = this.getTouchDistance(event.touches[0], event.touches[1]);
        const ratio = nextDistance / this.pinchDistance;
        const center = this.getTouchCenter(event.touches[0], event.touches[1]);
        const centerDelta = this.pinchCenter
          ? { x: center.x - this.pinchCenter.x, y: center.y - this.pinchCenter.y }
          : { x: 0, y: 0 };

        this.panX = this.pinchBasePan.x + centerDelta.x;
        this.panY = this.pinchBasePan.y + centerDelta.y;
        this.applyZoom(this.pinchBaseScale * ratio, center);
      },
      { passive: false }
    );

    stage.addEventListener("touchend", () => {
      this.pinchDistance = null;
      this.pinchCenter = null;
    });

    stage.addEventListener(
      "gesturestart",
      (event) => {
        event.preventDefault();
        void this.debugLog("gesture-start", JSON.stringify({ scale: (event as Event & { scale?: number }).scale ?? null }));
        this.pinchBaseScale = this.getCurrentSingleScale();
        this.pinchBasePan = { x: this.panX, y: this.panY };
      },
      { passive: false }
    );

    stage.addEventListener(
      "gesturechange",
      (event) => {
        event.preventDefault();
        const gestureEvent = event as Event & { scale?: number; clientX?: number; clientY?: number };
        const ratio = gestureEvent.scale ?? 1;
        const point =
          gestureEvent.clientX !== undefined && gestureEvent.clientY !== undefined
            ? { x: gestureEvent.clientX, y: gestureEvent.clientY }
            : this.lastPointerPoint ?? undefined;
        void this.debugLog(
          "gesture-change",
          JSON.stringify({ scale: ratio, clientX: gestureEvent.clientX ?? null, clientY: gestureEvent.clientY ?? null })
        );
        this.applyZoom(this.pinchBaseScale * ratio, point);
      },
      { passive: false }
    );

    stage.addEventListener("gestureend", () => {
      void this.debugLog("gesture-end", "ok");
      this.pinchDistance = null;
      this.pinchCenter = null;
    });

    this.preloadNearby();
  }

  private async renderStripView() {
    const viewport = this.getViewport();
    if (this.stripObserver) {
      this.stripObserver.disconnect();
      this.stripObserver = null;
    }
    this.stripLoadQueue = [];
    this.stripActiveLoads = 0;

    viewport.innerHTML = `
      <section class="strip-view" id="strip-view"></section>
    `;

    const strip = viewport.querySelector<HTMLDivElement>("#strip-view")!;
    strip.style.setProperty("--strip-width", `${this.stripWidthPercent}%`);

    if (!this.payload || !this.payload.images.length) {
      this.renderEmpty("没有可显示的图片。");
      return;
    }

    const fragment = document.createDocumentFragment();
    for (let index = 0; index < this.payload.images.length; index += 1) {
      const imagePath = this.payload.images[index];
      const item = document.createElement("article");
      item.className = "strip-item";
      item.dataset.index = String(index);
      item.dataset.path = imagePath;

      const frame = document.createElement("div");
      frame.className = "strip-item__frame";

      const img = document.createElement("img");
      img.className = "strip-item__image is-loading";
      img.alt = this.fileNameFromPath(imagePath);
      img.draggable = false;

      const cached = this.cache.get(imagePath);
      if (cached) {
        img.onload = () => img.classList.remove("is-loading");
        img.src = cached.src;
        if (img.complete) {
          img.classList.remove("is-loading");
        }
      }

      frame.appendChild(img);
      item.appendChild(frame);
      fragment.appendChild(item);
    }
    strip.appendChild(fragment);

    this.stripObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const index = Number((entry.target as HTMLElement).dataset.index);
            if (!Number.isNaN(index)) {
              this.enqueueStripLoad(index);
            }
          }
        }
      },
      {
        root: strip,
        rootMargin: "800px 0px 800px 0px",
      }
    );

    const allItems = Array.from(strip.children) as HTMLElement[];
    allItems.forEach((item) => this.stripObserver?.observe(item));

    strip.addEventListener(
      "scroll",
      () => {
        this.closeContextMenu();
        if (this.stripScrollFrame) {
          cancelAnimationFrame(this.stripScrollFrame);
        }

        this.stripScrollFrame = requestAnimationFrame(() => {
          this.updateCurrentIndexFromStripCenter();
        });
      },
      { passive: true }
    );

    // Initial scroll to current index
    const target = strip.querySelector<HTMLElement>(`.strip-item[data-index="${this.currentIndex}"]`);
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "auto" });
    }

    // Queue priority loads for current image and neighbors
    this.enqueueStripLoad(this.currentIndex);
    if (this.currentIndex + 1 < this.payload.images.length) {
      this.enqueueStripLoad(this.currentIndex + 1);
    }
    if (this.currentIndex - 1 >= 0) {
      this.enqueueStripLoad(this.currentIndex - 1);
    }

    this.updateStatus();
    this.updateTitle();
  }

  private updateCurrentIndexFromStripCenter() {
    const viewport = this.getViewport();
    const rect = viewport.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    const el = document.elementFromPoint(centerX, centerY);
    const item = el?.closest<HTMLElement>(".strip-item");
    if (item && item.dataset.index !== undefined) {
      const index = Number(item.dataset.index);
      if (!Number.isNaN(index) && index !== this.currentIndex) {
        this.currentIndex = index;
        this.updateStatus();
        this.updateTitle();
      }
    }
  }

  private enqueueStripLoad(index: number) {
    if (!this.payload || index < 0 || index >= this.payload.images.length) {
      return;
    }

    const imagePath = this.payload.images[index];
    if (!imagePath || this.renderedStrip.has(imagePath) || this.loadingStrip.has(imagePath)) {
      return;
    }

    if (!this.stripLoadQueue.includes(index)) {
      this.stripLoadQueue.push(index);
      this.processStripLoadQueue();
    }
  }

  private processStripLoadQueue() {
    while (this.stripActiveLoads < this.maxConcurrentStripLoads && this.stripLoadQueue.length > 0) {
      const nextIndex = this.stripLoadQueue.shift()!;
      this.stripActiveLoads += 1;
      void this.loadStripImageAtIndex(nextIndex).finally(() => {
        this.stripActiveLoads -= 1;
        this.processStripLoadQueue();
      });
    }
  }

  private async loadStripImageAtIndex(index: number) {
    if (!this.payload || index < 0 || index >= this.payload.images.length) {
      return;
    }

    const imagePath = this.payload.images[index];
    if (!imagePath || this.renderedStrip.has(imagePath) || this.loadingStrip.has(imagePath)) {
      return;
    }

    const item = this.root.querySelector<HTMLDivElement>(`.strip-item[data-index="${index}"]`);
    const img = item?.querySelector<HTMLImageElement>("img");
    if (!img) {
      return;
    }

    this.loadingStrip.add(imagePath);
    try {
      const imageSrc = await this.loadImageSource(imagePath);
      img.onload = () => {
        img.classList.remove("is-loading");
      };
      img.onerror = () => {
        img.classList.remove("is-loading");
        void this.debugLog("strip-image-error", JSON.stringify({ imagePath, imageSrc }));
      };
      img.src = imageSrc;
      if (img.complete) {
        img.classList.remove("is-loading");
      }
      this.renderedStrip.add(imagePath);
    } catch (error) {
      void this.debugLog("strip-image-error", JSON.stringify({ imagePath, error: String(error) }));
    } finally {
      this.loadingStrip.delete(imagePath);
    }
  }

  private syncStripViewport() {
    const strip = this.root.querySelector<HTMLDivElement>("#strip-view");
    if (!strip) {
      return;
    }

    const target = strip.querySelector<HTMLElement>(`.strip-item[data-index="${this.currentIndex}"]`);
    target?.scrollIntoView({ block: "start", behavior: "auto" });
  }

  private canCurrentSingleImagePan(): boolean {
    if (!this.singleImageNaturalWidth || !this.singleImageNaturalHeight) {
      return false;
    }
    const stageRect = this.getSingleStageRect();
    const renderedWidth = this.getSingleImageRenderedWidth();
    const renderedHeight = this.getSingleImageRenderedHeight();
    return renderedWidth > stageRect.width || renderedHeight > stageRect.height;
  }

  private getSingleImageRenderedWidth(): number {
    if (!this.singleImageNaturalWidth) return 0;
    if (this.scaleMode === "fit-width") {
      return this.getAvailableSingleImageWidth();
    }
    if (this.scaleMode === "fit-height") {
      return this.singleImageNaturalWidth * (this.getAvailableSingleImageHeight() / this.singleImageNaturalHeight);
    }
    return Math.max(this.singleImageNaturalWidth * this.scale, 1);
  }

  private getSingleImageRenderedHeight(): number {
    if (!this.singleImageNaturalHeight) return 0;
    if (this.scaleMode === "fit-width") {
      return this.singleImageNaturalHeight * (this.getAvailableSingleImageWidth() / this.singleImageNaturalWidth);
    }
    if (this.scaleMode === "fit-height") {
      return this.getAvailableSingleImageHeight();
    }
    return Math.max(this.singleImageNaturalHeight * this.scale, 1);
  }

  private clampPan() {
    if (!this.singleImageNaturalWidth || !this.singleImageNaturalHeight) {
      return;
    }

    const stageRect = this.getSingleStageRect();
    const renderedWidth = this.getSingleImageRenderedWidth();
    const renderedHeight = this.getSingleImageRenderedHeight();

    const maxPanX = Math.max(0, (renderedWidth - stageRect.width) / 2);
    const maxPanY = Math.max(0, (renderedHeight - stageRect.height) / 2);

    this.panX = Math.min(Math.max(this.panX, -maxPanX), maxPanX);
    this.panY = Math.min(Math.max(this.panY, -maxPanY), maxPanY);
  }

  private applySingleImageTransform() {
    this.clampPan();

    const image = this.root.querySelector<HTMLImageElement>("#single-image");
    if (!image) {
      return;
    }

    if (this.scaleMode === "fit-width") {
      image.style.width = `${this.getAvailableSingleImageWidth()}px`;
      image.style.height = "auto";
      image.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    } else if (this.scaleMode === "fit-height") {
      image.style.width = "auto";
      image.style.height = `${this.getAvailableSingleImageHeight()}px`;
      image.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    } else {
      image.style.width = `${Math.max(this.singleImageNaturalWidth * this.scale, 1)}px`;
      image.style.height = "auto";
      image.style.transform = `translate(${this.panX}px, ${this.panY}px)`;
    }

    const stage = this.root.querySelector<HTMLDivElement>("#single-stage");
    if (stage) {
      stage.classList.toggle("can-pan", this.canCurrentSingleImagePan());
    }

    this.updateStatus();
  }

  private preloadNearby() {
    if (!this.payload) {
      return;
    }

    const tasks: Promise<string>[] = [];
    for (let offset = -PRELOAD_DISTANCE; offset <= PRELOAD_DISTANCE; offset += 1) {
      if (offset === 0) {
        continue;
      }

      const path = this.payload.images[this.currentIndex + offset];
      if (!path || this.cache.has(path)) {
        continue;
      }

      tasks.push(this.loadImageSource(path));
    }

    void Promise.allSettled(tasks);
  }

  private async loadImageSource(path: string): Promise<string> {
    const cached = this.cache.get(path);
    if (cached) {
      cached.loadedAt = Date.now();
      return cached.src;
    }

    const src = await invoke<string>("read_image_data_url", { path });
    this.cache.set(path, { src, loadedAt: Date.now() });
    this.evictCacheIfNeeded();
    void this.primeDecode(src);
    return src;
  }

  private handleSingleImageError(imagePath: string) {
    void this.debugLog("image-error", JSON.stringify({ imagePath }));

    this.getViewport().innerHTML = `
      <section class="empty-state">
        <h1>图片加载失败</h1>
        <p>${this.escapeHtml(this.fileNameFromPath(imagePath))}</p>
      </section>
    `;
    this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent =
      `图片加载失败：${this.fileNameFromPath(imagePath)}`;
    this.updateTitle();
  }

  private async primeDecode(src: string) {
    const image = new Image();
    image.src = src;

    try {
      await image.decode();
    } catch {
      // Ignore decode failures here and let the visible element report load state.
    }
  }

  private async prepareDefaultApp() {
    const button = this.root.querySelector<HTMLButtonElement>("#default-app");
    if (!button) {
      return;
    }

    button.disabled = true;
    try {
      const result = await invoke<AssociationResult>("prepare_default_app_integration");
      this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent = result.message;
    } catch (error) {
      this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent = `默认应用设置失败：${String(error)}`;
    } finally {
      button.disabled = false;
    }
  }

  private async toggleMaximize() {
    await invoke("toggle_maximize_window");
    void this.refreshWindowChrome();
  }

  private handleDomDrop = async (event: DragEvent) => {
    event.preventDefault();
    const path = this.extractDropPath(event);
    if (!path) {
      this.root.querySelector<HTMLElement>("#statusbar")!.innerHTML =
        `<span class="statusbar__text">拖入的内容里没有可打开的图片文件。</span>`;
      void this.debugLog(
        "dom-drop-miss",
        JSON.stringify({
          uriList: event.dataTransfer?.getData("text/uri-list") ?? "",
          plainText: event.dataTransfer?.getData("text/plain") ?? "",
          fileCount: event.dataTransfer?.files?.length ?? 0,
        })
      );
      return;
    }

    await this.openPath(path);
  };

  private async handleNativeDropPaths(paths: string[]) {
    void this.debugLog("native-drop", JSON.stringify(paths));
    const firstImagePath = paths.find((path) => IMAGE_EXTENSION_PATTERN.test(path)) ?? paths[0];
    if (!firstImagePath) {
      this.root.querySelector<HTMLDivElement>("#statusbar")!.textContent =
        "拖入的文件里没有可打开的图片格式。";
      return;
    }

    await this.openPath(firstImagePath);
  }

  private handleDomDragOver = (event: DragEvent) => {
    event.preventDefault();
  };

  private extractDropPath(event: DragEvent) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    const imageFile = files.find((file) => IMAGE_EXTENSION_PATTERN.test(file.name));
    const filePath = (imageFile as File & { path?: string } | undefined)?.path;
    if (filePath) {
      return this.normalizeInputPath(filePath);
    }

    if (files.length > 0) {
      const anyFilePath = (files[0] as File & { path?: string })?.path;
      if (anyFilePath) {
        return this.normalizeInputPath(anyFilePath);
      }
    }

    const uriList = event.dataTransfer?.getData("text/uri-list")?.trim();
    if (uriList) {
      const candidate = uriList
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line && !line.startsWith("#"));
      if (candidate) {
        return this.normalizeInputPath(candidate);
      }
    }

    const plainText = event.dataTransfer?.getData("text/plain")?.trim();
    if (plainText) {
      return this.normalizeInputPath(plainText);
    }

    return null;
  }

  private normalizeInputPath(raw: string | null | undefined) {
    if (!raw) {
      return null;
    }

    const trimmed = raw.trim().replace(/^"+|"+$/g, "");
    if (!trimmed) {
      return null;
    }

    if (/^file:\/\//i.test(trimmed)) {
      try {
        const url = new URL(trimmed);
        let pathname = decodeURIComponent(url.pathname);
        if (/^\/[A-Za-z]:/.test(pathname)) {
          pathname = pathname.slice(1);
        }

        if (url.hostname) {
          pathname = `\\\\${url.hostname}${pathname.replaceAll("/", "\\")}`;
        } else {
          pathname = pathname.replaceAll("/", "\\");
        }

        return pathname;
      } catch {
        return trimmed;
      }
    }

    return trimmed;
  }

  private applyWheelZoom(event: WheelEvent) {
    this.logWheelShape(event);
    const now = performance.now();
    if (now - this.lastWheelZoomAt > 160) {
      this.pinchBaseScale = this.getCurrentSingleScale();
    }
    this.lastWheelZoomAt = now;

    const sensitivity =
      Math.abs(event.deltaY) >= MOUSE_WHEEL_DELTA_STEP
        ? CTRL_MOUSE_WHEEL_ZOOM_SENSITIVITY
        : TOUCHPAD_PINCH_ZOOM_SENSITIVITY;
    const factor = Math.exp(-event.deltaY * sensitivity);
    const anchorPoint =
      event.clientX || event.clientY
        ? { x: event.clientX, y: event.clientY }
        : this.lastPointerPoint ?? undefined;
    this.applyZoom(this.getCurrentSingleScale() * factor, anchorPoint);
  }

  private applyZoom(nextScale: number, anchorPoint?: { x: number; y: number }) {
    const oldScale = this.getCurrentSingleScale();
    const clampedScale = Math.min(Math.max(nextScale, 0.1), 8);

    if (this.singleImageNaturalWidth && this.singleImageNaturalHeight && anchorPoint && oldScale > 0) {
      const stageRect = this.getSingleStageRect();
      const centerX = stageRect.left + stageRect.width / 2;
      const centerY = stageRect.top + stageRect.height / 2;
      const ratio = clampedScale / oldScale;

      const offsetX = anchorPoint.x - centerX - this.panX;
      this.panX = anchorPoint.x - centerX - offsetX * ratio;

      const offsetY = anchorPoint.y - centerY - this.panY;
      this.panY = anchorPoint.y - centerY - offsetY * ratio;
    }

    this.scaleMode = "custom";
    this.scale = clampedScale;
    this.applySingleImageTransform();
  }

  private resetSingleScaleToLongSide() {
    if (!this.singleImageNaturalWidth || !this.singleImageNaturalHeight) {
      return;
    }

    const availableWidth = this.getAvailableSingleImageWidth();
    const availableHeight = this.getAvailableSingleImageHeight();
    const heightIfFitWidth =
      this.singleImageNaturalHeight * (availableWidth / this.singleImageNaturalWidth);
      
    // 同初始化逻辑，防止在部分比例下直接使用 fit-width 导致高度严重溢出
    this.scaleMode = heightIfFitWidth <= availableHeight - 1 ? "fit-width" : "fit-height";
    this.scale = 1;
    this.resetPan();
    this.applySingleImageTransform();
  }

  private resetPan() {
    this.panX = 0;
    this.panY = 0;
  }

  private getSingleStageRect() {
    return (
      this.root.querySelector<HTMLDivElement>("#single-stage")?.getBoundingClientRect() ??
      this.getViewport().getBoundingClientRect()
    );
  }

  private logWheelShape(event: WheelEvent) {
    const now = performance.now();
    if (now - this.lastWheelDebugAt < 1000) {
      return;
    }

    this.lastWheelDebugAt = now;
    void this.debugLog(
      "wheel-shape",
      JSON.stringify({
        deltaX: Number(event.deltaX.toFixed(3)),
        deltaY: Number(event.deltaY.toFixed(3)),
        deltaMode: event.deltaMode,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      })
    );
  }

  private getCurrentSingleScale() {
    if (!this.singleImageNaturalWidth || !this.singleImageNaturalHeight) {
      return this.scale;
    }

    if (this.scaleMode === "fit-width") {
      return this.getAvailableSingleImageWidth() / this.singleImageNaturalWidth;
    }

    if (this.scaleMode === "fit-height") {
      return this.getAvailableSingleImageHeight() / this.singleImageNaturalHeight;
    }

    return this.scale;
  }

  private evictCacheIfNeeded() {
    if (this.cache.size <= CACHE_LIMIT) {
      return;
    }

    const entries = Array.from(this.cache.entries()).sort((a, b) => a[1].loadedAt - b[1].loadedAt);
    while (entries.length && this.cache.size > CACHE_LIMIT) {
      const [oldestPath] = entries.shift()!;
      this.cache.delete(oldestPath);
    }
  }

  private currentPath() {
    return this.payload?.images[this.currentIndex] ?? null;
  }

  private getViewport() {
    return this.root.querySelector<HTMLDivElement>("#viewport")!;
  }

  private getShell() {
    return this.root.querySelector<HTMLDivElement>(".app-shell")!;
  }

  private updateTitle() {
    const path = this.currentPath();
    const fileName = path ? this.fileNameFromPath(path) : "未打开图片";
    const pathElement = this.root.querySelector<HTMLSpanElement>("#current-path")!;
    pathElement.textContent = fileName;
    pathElement.title = path ?? "";
    const titleText = path ? `See - ${fileName}` : "See";
    document.title = titleText;
    void this.appWindow.setTitle(titleText).catch(() => {});
  }

  private updateStatus() {
    const statusbar = this.root.querySelector<HTMLElement>("#statusbar")!;
    const total = this.payload?.images.length ?? 0;
    const zoomLabel =
      this.mode === "single"
        ? `${Math.round(this.getCurrentSingleScale() * 100)}%`
        : "长页浏览";

    const baseText = this.statusNotice
      ? this.statusNotice
      : total
        ? `${this.currentIndex + 1} / ${total}`
        : "准备就绪";
    const modeHint = this.mode === "single" ? "滚轮切图" : "滚轮滚动";
    const scaleControl =
      this.mode === "single"
        ? `<button class="statusbar__scale-button" id="scale-reset-button" type="button" title="长边 100%">${this.escapeHtml(zoomLabel)}</button>`
        : `<span>${this.escapeHtml(zoomLabel)}</span>`;
    const widthControl = this.mode === "strip"
      ? `
        <form class="statusbar__form" id="strip-width-form">
          <label class="statusbar__label" for="strip-width-input">宽度</label>
          <input class="statusbar__input" id="strip-width-input" type="number" min="10" max="300" step="1" value="${this.stripWidthPercent}" />
          <span class="statusbar__suffix">%</span>
        </form>
      `
      : "";

    statusbar.innerHTML = `
      <span class="statusbar__text">${this.escapeHtml(baseText)} · ${scaleControl} · ${this.escapeHtml(modeHint)}</span>
      ${widthControl}
    `;

    statusbar.querySelector<HTMLButtonElement>("#scale-reset-button")?.addEventListener("click", () => {
      this.resetSingleScaleToLongSide();
    });

    const applyWidthInput = () => {
      const input = statusbar.querySelector<HTMLInputElement>("#strip-width-input");
      const nextValue = Number(input?.value ?? this.stripWidthPercent);
      if (!Number.isFinite(nextValue)) {
        return;
      }
      const clamped = Math.min(Math.max(Math.round(nextValue), 10), 300);
      if (this.mode !== "strip") {
        return;
      }

      this.stripWidthPercent = clamped;
      if (input) {
        input.value = String(this.stripWidthPercent);
      }
      this.root
        .querySelector<HTMLDivElement>("#strip-view")
        ?.style.setProperty("--strip-width", `${this.stripWidthPercent}%`);
    };

    statusbar.querySelector<HTMLFormElement>("#strip-width-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      applyWidthInput();
    });
    statusbar.querySelector<HTMLInputElement>("#strip-width-input")?.addEventListener("change", applyWidthInput);
    statusbar.querySelector<HTMLInputElement>("#strip-width-input")?.addEventListener("blur", applyWidthInput);

    const modeToggle = this.root.querySelector<HTMLButtonElement>("#mode-toggle")!;
    modeToggle.textContent = this.mode === "single" ? "长页模式" : "单张模式";
  }

  private renderEmpty(message: string) {
    this.getViewport().innerHTML = `
      <section class="empty-state">
        <h1>See</h1>
        <p>${message}</p>
      </section>
    `;
    this.root.querySelector<HTMLElement>("#statusbar")!.innerHTML =
      `<span class="statusbar__text">等待图片</span>`;
  }

  private handleWindowResize = () => {
    if (
      this.mode === "single" &&
      (this.scaleMode === "fit-width" || this.scaleMode === "fit-height")
    ) {
      this.applySingleImageTransform();
    }
  };

  private handleDragPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }

    if ((event.target as HTMLElement).closest("button")) {
      return;
    }

    this.dragPointerId = event.pointerId;
    this.dragStartPoint = { x: event.clientX, y: event.clientY };
    this.dragTriggered = false;
  };

  private handleDragPointerMove = (event: PointerEvent) => {
    if (this.dragPointerId !== event.pointerId || !this.dragStartPoint || this.dragTriggered) {
      return;
    }

    const movedX = Math.abs(event.clientX - this.dragStartPoint.x);
    const movedY = Math.abs(event.clientY - this.dragStartPoint.y);
    if (movedX < 4 && movedY < 4) {
      return;
    }

    this.dragTriggered = true;
    void invoke("start_window_drag");
  };

  private handleDragPointerEnd = (event: PointerEvent) => {
    if (this.dragPointerId !== event.pointerId) {
      return;
    }

    this.dragPointerId = null;
    this.dragStartPoint = null;
    this.dragTriggered = false;
  };

  private getTouchDistance(first: Touch, second: Touch) {
    return Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY);
  }

  private getTouchCenter(first: Touch, second: Touch) {
    return {
      x: (first.clientX + second.clientX) / 2,
      y: (first.clientY + second.clientY) / 2,
    };
  }

  private fileNameFromPath(path: string) {
    return path.split(/[\\/]/).pop() || path;
  }

  private async refreshWindowChrome() {
    try {
      const isFullscreen = await invoke<boolean>("is_presentation_mode");
      this.applyFullscreenChrome(isFullscreen);

      const maxBtn = this.root.querySelector<HTMLButtonElement>("#window-maximize");
      if (maxBtn) {
        const isMax = await this.appWindow.isMaximized();
        maxBtn.textContent = isMax ? "❐" : "□";
        maxBtn.title = isMax ? "还原" : "最大化";
      }
    } catch (error) {
      void this.debugLog("refresh-window-chrome-error", String(error));
    }
  }

  private applyFullscreenChrome(isFullscreen: boolean) {
    this.isPresentationMode = isFullscreen;
    const shell = this.getShell();
    shell.classList.toggle("is-fullscreen", isFullscreen);
    this.root.querySelector<HTMLElement>(".topbar")!.hidden = isFullscreen;
    this.root.querySelector<HTMLElement>(".statusbar")!.hidden = isFullscreen;
    requestAnimationFrame(() => {
      this.syncCurrentLayoutAfterPresentationChange();
    });
    window.setTimeout(() => {
      this.syncCurrentLayoutAfterPresentationChange();
    }, 60);
    window.setTimeout(() => {
      this.syncCurrentLayoutAfterPresentationChange();
    }, 180);
  }

  private syncCurrentLayoutAfterPresentationChange() {
    if (!this.payload?.images.length) {
      return;
    }

    if (this.mode === "single") {
      this.applySingleImageTransform();
      this.root.querySelector<HTMLImageElement>("#single-image")?.classList.remove("is-loading");
      this.logSingleLayout("presentation-sync");
      this.updateStatus();
      return;
    }

    if (this.mode === "strip") {
      this.root
        .querySelector<HTMLDivElement>("#strip-view")
        ?.style.setProperty("--strip-width", `${this.stripWidthPercent}%`);
      this.syncStripViewport();
      this.updateStatus();
    } else {
      this.handleWindowResize();
    }
  }

  private getAvailableSingleImageHeight() {
    const viewportHeight = this.getViewport().clientHeight || window.innerHeight;
    return Math.max(viewportHeight, 1);
  }

  private getAvailableSingleImageWidth() {
    const viewportWidth = this.getViewport().clientWidth || window.innerWidth;
    return Math.max(viewportWidth - (this.isPresentationMode ? 0 : 32), 1);
  }

  private logSingleLayout(label: string) {
    const image = this.root.querySelector<HTMLImageElement>("#single-image");
    const viewportRect = this.getViewport().getBoundingClientRect();
    const imageRect = image?.getBoundingClientRect();
    void this.debugLog(
      label,
      JSON.stringify({
        viewport: {
          width: Math.round(viewportRect.width),
          height: Math.round(viewportRect.height),
          left: Math.round(viewportRect.left),
          top: Math.round(viewportRect.top),
        },
        image: imageRect
          ? {
              width: Math.round(imageRect.width),
              height: Math.round(imageRect.height),
              left: Math.round(imageRect.left),
              top: Math.round(imageRect.top),
            }
          : null,
        complete: image?.complete ?? null,
        naturalWidth: image?.naturalWidth ?? null,
        naturalHeight: image?.naturalHeight ?? null,
        mode: this.scaleMode,
        scale: Number(this.getCurrentSingleScale().toFixed(4)),
        panX: Math.round(this.panX),
        panY: Math.round(this.panY),
      })
    );
  }

  private async debugLog(label: string, message: string) {
    try {
      await invoke("append_debug_log", { label, message });
    } catch {
      // Ignore logging failures.
    }
  }

  private escapeHtml(value: string) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  private handleContextMenu(event: MouseEvent) {
    if (!this.payload || !this.payload.images.length) {
      this.closeContextMenu();
      return;
    }

    let targetPath: string | null = null;

    if (this.mode === "strip") {
      const item = (event.target as HTMLElement | null)?.closest<HTMLElement>(".strip-item");
      if (item && item.dataset.path) {
        targetPath = item.dataset.path;
      } else {
        targetPath = this.currentPath();
      }
    } else {
      targetPath = this.currentPath();
    }

    if (!targetPath) {
      this.closeContextMenu();
      return;
    }

    this.openContextMenu(event.clientX, event.clientY, targetPath);
  }

  private openContextMenu(x: number, y: number, targetPath: string) {
    this.closeContextMenu();
    this.contextMenuTarget = targetPath;

    const menu = document.createElement("div");
    menu.className = "context-menu";
    menu.id = "context-menu";
    menu.style.visibility = "hidden";
    menu.innerHTML = `
      <button class="context-menu__item" data-action="delete" type="button">
        <span class="context-menu__item-main">
          <svg class="context-menu__icon" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          <span class="context-menu__label">删除</span>
        </span>
        <span class="context-menu__shortcut">Del</span>
      </button>
      <div class="context-menu__separator"></div>
      <button class="context-menu__item context-menu__item--danger" data-action="delete-permanent" type="button">
        <span class="context-menu__item-main">
          <svg class="context-menu__icon" viewBox="0 0 24 24">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
            <line x1="10" y1="11" x2="10" y2="17"></line>
            <line x1="14" y1="11" x2="14" y2="17"></line>
          </svg>
          <span class="context-menu__label">彻底删除（不放回收站）</span>
        </span>
        <span class="context-menu__shortcut">Shift+Del</span>
      </button>
    `;

    menu.querySelector<HTMLButtonElement>('[data-action="delete"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = this.contextMenuTarget;
      this.closeContextMenu();
      if (path) {
        void this.deleteImage(path, false);
      }
    });

    menu.querySelector<HTMLButtonElement>('[data-action="delete-permanent"]')?.addEventListener("click", (e) => {
      e.stopPropagation();
      const path = this.contextMenuTarget;
      this.closeContextMenu();
      if (path) {
        void this.deleteImage(path, true);
      }
    });

    document.body.appendChild(menu);
    this.contextMenuElement = menu;

    const menuRect = menu.getBoundingClientRect();
    const margin = 8;
    let posX = x;
    let posY = y;

    if (posX + menuRect.width > window.innerWidth - margin) {
      posX = Math.max(margin, window.innerWidth - menuRect.width - margin);
    }
    if (posY + menuRect.height > window.innerHeight - margin) {
      posY = Math.max(margin, window.innerHeight - menuRect.height - margin);
    }

    menu.style.left = `${posX}px`;
    menu.style.top = `${posY}px`;
    menu.style.visibility = "";
  }

  private isContextMenuOpen(): boolean {
    return Boolean(this.contextMenuElement && this.contextMenuElement.isConnected);
  }

  private closeContextMenu = () => {
    if (this.contextMenuElement) {
      this.contextMenuElement.remove();
      this.contextMenuElement = null;
      this.contextMenuTarget = null;
    }
  };

  private async deleteImage(targetPath: string, permanently: boolean) {
    if (!this.payload || !this.payload.images.length) {
      return;
    }

    const fileName = this.fileNameFromPath(targetPath);

    try {
      await invoke("delete_image_file", { path: targetPath, permanently });
      void this.debugLog("delete-image-success", JSON.stringify({ path: targetPath, permanently }));
    } catch (error) {
      void this.debugLog("delete-image-error", JSON.stringify({ path: targetPath, permanently, error: String(error) }));
      this.showStatusNotice(`删除失败：${String(error)}`, 5000);
      return;
    }

    const targetIndex = this.payload.images.indexOf(targetPath);
    if (targetIndex === -1) {
      return;
    }

    // Cleanup caches
    this.cache.delete(targetPath);
    this.renderedStrip.delete(targetPath);
    this.loadingStrip.delete(targetPath);

    // Remove from image list
    this.payload.images.splice(targetIndex, 1);
    this.stripLoadQueue = this.stripLoadQueue
      .filter((idx) => idx !== targetIndex)
      .map((idx) => (idx > targetIndex ? idx - 1 : idx));

    const actionLabel = permanently ? "彻底删除" : "移至回收站";

    if (this.payload.images.length === 0) {
      this.payload.currentPath = null;
      this.currentIndex = 0;
      this.renderEmpty("文件夹中已无更多图片。");
      this.updateTitle();
      this.showStatusNotice(`已${actionLabel}：${fileName} · 文件夹已空`);
      return;
    }

    // Adjust currentIndex
    if (targetIndex < this.currentIndex) {
      this.currentIndex -= 1;
    } else if (targetIndex === this.currentIndex) {
      if (this.currentIndex >= this.payload.images.length) {
        this.currentIndex = this.payload.images.length - 1;
      }
    }
    this.payload.currentPath = this.payload.images[this.currentIndex];

    if (this.mode === "single") {
      await this.renderSingleView(true);
      this.preloadNearby();
      this.showStatusNotice(`已${actionLabel}：${fileName}`);
    } else {
      const strip = this.root.querySelector<HTMLDivElement>("#strip-view");
      if (strip) {
        const items = Array.from(strip.querySelectorAll<HTMLElement>(".strip-item"));
        const targetItem = items.find((elem) => elem.dataset.path === targetPath);
        if (targetItem && this.stripObserver) {
          this.stripObserver.unobserve(targetItem);
        }
        targetItem?.remove();

        const remainingItems = Array.from(strip.querySelectorAll<HTMLElement>(".strip-item"));
        remainingItems.forEach((elem, idx) => {
          elem.dataset.index = String(idx);
        });
        this.updateCurrentIndexFromStripCenter();
        this.updateTitle();
        this.updateStatus();
      }
      this.showStatusNotice(`已${actionLabel}：${fileName}`);
    }
  }

  private showStatusNotice(message: string, durationMs = 3500) {
    this.statusNotice = message;
    if (this.statusNoticeTimer) {
      window.clearTimeout(this.statusNoticeTimer);
    }
    this.updateStatus();
    this.showToast(message, Math.min(durationMs, 3000));
    this.statusNoticeTimer = window.setTimeout(() => {
      this.statusNotice = null;
      this.statusNoticeTimer = null;
      this.updateStatus();
    }, durationMs);
  }

  private showToast(message: string, durationMs = 2500) {
    if (this.toastElement) {
      this.toastElement.remove();
      this.toastElement = null;
    }
    if (this.toastTimer) {
      window.clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }

    const toast = document.createElement("div");
    toast.className = "toast-notice";
    toast.textContent = message;
    document.body.appendChild(toast);
    this.toastElement = toast;

    this.toastTimer = window.setTimeout(() => {
      if (this.toastElement === toast) {
        toast.remove();
        this.toastElement = null;
        this.toastTimer = null;
      }
    }, durationMs);
  }

  private async toggleFullscreen() {
    try {
      const isFullscreen = await invoke<boolean>("toggle_presentation_mode");
      this.applyFullscreenChrome(isFullscreen);
      window.setTimeout(() => void this.refreshWindowChrome(), 60);
      window.setTimeout(() => void this.refreshWindowChrome(), 180);
    } catch (error) {
      void this.debugLog("toggle-fullscreen-error", String(error));
    }
  }
}

const app = new ViewerApp();
void app.init();
