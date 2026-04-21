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
const STRIP_AHEAD_COUNT = 3;
const STRIP_LOAD_MARGIN_PX = 2400;
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
  private lastWheelNavigateAt = 0;
  private lastWheelDebugAt = 0;
  private lastPointerPoint: { x: number; y: number } | null = null;
  private dragPointerId: number | null = null;
  private dragStartPoint: { x: number; y: number } | null = null;
  private dragTriggered = false;
  private imageFallbacks = new Set<string>();
  private stripLoadedCount = 0;
  private stripWidthPercent = 100;
  private isPresentationMode = false;
  private panX = 0;
  private panY = 0;

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

      this.stripLoadedCount = this.getInitialStripLoadedCount();
      await this.renderSingleView(true);
      this.preloadNearby();
    } catch (error) {
      void this.debugLog("init-error", String(error));
      this.renderEmpty(`启动失败：${String(error)}`);
    }
  }

  private bindNativeBridges() {
    (
      window as Window & {
        __SEE_SYNC_PRESENTATION_MODE__?: (enabled: boolean) => void;
        __SEE_OPEN_DROPPED_PATHS__?: (paths: string[]) => void;
      }
    ).__SEE_SYNC_PRESENTATION_MODE__ = (enabled: boolean) => {
      this.applyFullscreenChrome(Boolean(enabled));
    };

    (
      window as Window & {
        __SEE_SYNC_PRESENTATION_MODE__?: (enabled: boolean) => void;
        __SEE_OPEN_DROPPED_PATHS__?: (paths: string[]) => void;
      }
    ).__SEE_OPEN_DROPPED_PATHS__ = (paths: string[]) => {
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
              <button class="window-button" id="window-maximize" title="最大化">口</button>
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

    document.addEventListener(
      "dragover",
      this.handleDomDragOver,
      { passive: false }
    );

    document.addEventListener(
      "drop",
      this.handleDomDrop,
      { passive: false }
    );

    this.root.addEventListener(
      "dragover",
      this.handleDomDragOver,
      { passive: false }
    );

    this.root.addEventListener(
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

      if (event.key === STRIP_TOGGLE_KEY) {
        event.preventDefault();
        void this.toggleMode();
        return;
      }

      if (this.mode === "single") {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          void this.goToIndex(this.currentIndex - 1);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          void this.goToIndex(this.currentIndex + 1);
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
        if (this.mode !== "single") {
          return;
        }

        if (!event.ctrlKey && !event.metaKey) {
          return;
        }

        event.preventDefault();
        this.applyWheelZoom(event);
      },
      { passive: false, capture: true }
    );

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
      this.stripLoadedCount = this.getInitialStripLoadedCount();
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
    this.mode = this.mode === "single" ? "strip" : "single";

    if (this.mode === "single") {
      await this.renderSingleView(false);
      return;
    }

    await this.warmStripImages();
    await this.renderStripView();
  }

  private async goToIndex(nextIndex: number) {
    if (!this.payload) {
      return;
    }

    const boundedIndex = Math.min(Math.max(nextIndex, 0), this.payload.images.length - 1);
    if (boundedIndex === this.currentIndex) {
      return;
    }

    this.currentIndex = boundedIndex;

    if (this.mode === "single") {
      await this.renderSingleView(true);
    } else {
      this.syncStripViewport();
      void this.loadVisibleStripImages();
    }

    this.preloadNearby();
  }

  private async renderSingleView(resetScale: boolean) {
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
      void this.handleSingleImageError(image, imagePath);
    };
    image.onload = applyLoadedLayout;
    image.src = imageSrc;
    if (image.complete) {
      applyLoadedLayout();
    }

    stage.addEventListener(
      "wheel",
      (event) => {
        event.stopPropagation();
        if (this.shouldZoomFromWheel(event)) {
          event.preventDefault();
          this.applyWheelZoom(event);
          return;
        }

        event.preventDefault();
        if (this.isPrecisionTouchpadPan(event)) {
          this.panBy(event.deltaX, event.deltaY);
        } else {
          void this.navigateFromWheel(event);
        }
      },
      { passive: false }
    );

    stage.addEventListener(
      "pointermove",
      (event) => {
        this.lastPointerPoint = { x: event.clientX, y: event.clientY };
      },
      { passive: true }
    );

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

    window.removeEventListener("resize", this.handleWindowResize);
    window.addEventListener("resize", this.handleWindowResize, { passive: true });
    this.preloadNearby();
  }

  private async renderStripView() {
    const viewport = this.getViewport();
    // 一次性将全部图片 DOM 建好，由 CSS content-visibility:auto 控制渲染
    this.stripLoadedCount = this.payload?.images.length ?? 0;

    viewport.innerHTML = `
      <section class="strip-view" id="strip-view"></section>
    `;

    const strip = viewport.querySelector<HTMLDivElement>("#strip-view")!;
    strip.style.setProperty("--strip-width", `${this.stripWidthPercent}%`);
    this.renderedStrip.clear();
    this.loadingStrip.clear();
    this.appendStripItems(strip);

    strip.addEventListener(
      "scroll",
      () => {
        if (this.stripScrollFrame) {
          cancelAnimationFrame(this.stripScrollFrame);
        }

        this.stripScrollFrame = requestAnimationFrame(() => {
          this.updateCurrentIndexFromStrip();
          this.preloadNextStripImage();
          void this.loadVisibleStripImages();
        });
      },
      { passive: true }
    );

    this.syncStripViewport();
    this.preloadNextStripImage();
    await this.loadVisibleStripImages();
    this.updateStatus();
    this.updateTitle();
  }

  private updateCurrentIndexFromStrip() {
    const strip = this.root.querySelector<HTMLDivElement>("#strip-view");
    if (!strip) {
      return;
    }

    const viewportCenter = window.innerHeight / 2;
    let bestIndex = this.currentIndex;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const item of Array.from(strip.children) as HTMLDivElement[]) {
      const rect = item.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const distance = Math.abs(center - viewportCenter);

      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = Number(item.dataset.index);
      }
    }

    this.currentIndex = bestIndex;
    this.updateStatus();
    this.updateTitle();
  }

  private async loadVisibleStripImages() {
    const strip = this.root.querySelector<HTMLDivElement>("#strip-view");
    if (!strip || !this.payload) {
      return;
    }

    const candidates = Array.from(strip.children) as HTMLDivElement[];
    const tasks: Promise<void>[] = [];

    for (const item of candidates) {
      const index = Number(item.dataset.index);
      const imagePath = this.payload.images[index];

      if (!imagePath) {
        continue;
      }

      if (
        this.renderedStrip.has(imagePath) ||
        this.loadingStrip.has(imagePath) ||
        !this.isStripItemNearViewport(item)
      ) {
        continue;
      }

      // 并行发起所有可见图的加载，不串行等待
      tasks.push(this.loadStripImageAtIndex(index));
    }

    await Promise.allSettled(tasks);
  }

  private syncStripViewport() {
    const strip = this.root.querySelector<HTMLDivElement>("#strip-view");
    if (!strip) {
      return;
    }

    const target = strip.querySelector<HTMLElement>(`.strip-item[data-index="${this.currentIndex}"]`);
    target?.scrollIntoView({ block: "center", behavior: "auto" });
  }

  private ensureStripLoadedAhead() {
    // DOM 已在 renderStripView 时一次性全部创建，此方法保留为兼容空实现
  }

  private preloadNextStripImage() {
    if (this.mode !== "strip") {
      return;
    }

    void this.loadStripImageAtIndex(this.currentIndex + 1);
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
      img.src = imageSrc;
      img.onload = () => img.classList.remove("is-loading");
      img.onerror = () => {
        void this.debugLog("strip-image-error", JSON.stringify({ imagePath, imageSrc }));
      };
      this.renderedStrip.add(imagePath);
    } catch (error) {
      void this.debugLog("strip-image-error", JSON.stringify({ imagePath, error: String(error) }));
    } finally {
      this.loadingStrip.delete(imagePath);
    }
  }

  private isStripItemNearViewport(item: HTMLElement) {
    const rect = item.getBoundingClientRect();
    const topLimit = -STRIP_LOAD_MARGIN_PX;
    const bottomLimit = window.innerHeight + STRIP_LOAD_MARGIN_PX;
    return rect.bottom >= topLimit && rect.top <= bottomLimit;
  }

  private getInitialStripLoadedCount() {
    const total = this.payload?.images.length ?? 0;
    if (!total) {
      return 0;
    }

    return Math.min(total, this.currentIndex + STRIP_AHEAD_COUNT + 1);
  }

  private appendStripItems(strip: HTMLDivElement) {
    if (!this.payload) {
      return;
    }

    const existingCount = strip.children.length;
    for (let index = existingCount; index < this.stripLoadedCount; index += 1) {
      const imagePath = this.payload.images[index];
      if (!imagePath) {
        continue;
      }

      const item = document.createElement("article");
      item.className = "strip-item";
      item.dataset.index = String(index);
      item.dataset.path = imagePath;
      item.innerHTML = `
        <div class="strip-item__frame">
          <img class="strip-item__image is-loading" alt="" draggable="false" />
        </div>
      `;
      strip.appendChild(item);
    }
  }

  private clampPan() {
    if (!this.singleImageNaturalWidth || !this.singleImageNaturalHeight) {
      return;
    }

    const stageRect = this.getSingleStageRect();
    let renderedWidth = 0;
    let renderedHeight = 0;

    if (this.scaleMode === "fit-width") {
      renderedWidth = this.getAvailableSingleImageWidth();
      renderedHeight = this.singleImageNaturalHeight * (renderedWidth / this.singleImageNaturalWidth);
    } else if (this.scaleMode === "fit-height") {
      renderedHeight = this.getAvailableSingleImageHeight();
      renderedWidth = this.singleImageNaturalWidth * (renderedHeight / this.singleImageNaturalHeight);
    } else {
      renderedWidth = Math.max(this.singleImageNaturalWidth * this.scale, 1);
      renderedHeight = this.singleImageNaturalHeight * (renderedWidth / this.singleImageNaturalWidth);
    }

    const maxPanX = Math.abs(renderedWidth - stageRect.width) / 2;
    const maxPanY = Math.abs(renderedHeight - stageRect.height) / 2;

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

  private async handleSingleImageError(image: HTMLImageElement, imagePath: string) {
    void this.debugLog("image-error", JSON.stringify({ imagePath, currentSrc: image.currentSrc || image.src }));

    if (!this.imageFallbacks.has(imagePath)) {
      this.imageFallbacks.add(imagePath);
      try {
        const dataUrl = await invoke<string>("read_image_data_url", { path: imagePath });
        void this.debugLog("image-fallback", JSON.stringify({ imagePath, mode: "data-url" }));
        image.src = dataUrl;
        return;
      } catch (error) {
        void this.debugLog("image-fallback-error", JSON.stringify({ imagePath, error: String(error) }));
      }
    }

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

  private async warmStripImages() {
    if (!this.payload) {
      return;
    }

    const indexes = [this.currentIndex - 1, this.currentIndex, this.currentIndex + 1];
    const tasks = indexes
      .map((index) => this.payload?.images[index])
      .filter((path): path is string => Boolean(path))
      .map((path) => this.loadImageSource(path));

    await Promise.allSettled(tasks);
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
    const firstImagePath = paths.find((path) => IMAGE_EXTENSION_PATTERN.test(path));
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

  private shouldZoomFromWheel(event: WheelEvent) {
    this.logWheelShape(event);
    return event.ctrlKey || event.metaKey;
  }

  private isPrecisionTouchpadPan(event: WheelEvent) {
    return (
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL &&
      !(event.ctrlKey || event.metaKey) &&
      (Math.abs(event.deltaX) > 0 || Math.abs(event.deltaY) < 80)
    );
  }

  private looksLikeTouchpadPinch(event: WheelEvent) {
    return event.deltaMode === WheelEvent.DOM_DELTA_PIXEL && (event.ctrlKey || event.metaKey);
  }

  private async navigateFromWheel(event: WheelEvent) {
    const now = performance.now();
    if (now - this.lastWheelNavigateAt < 180) {
      return;
    }

    this.lastWheelNavigateAt = now;
    await this.goToIndex(this.currentIndex + (event.deltaY > 0 ? 1 : -1));
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

  private panBy(deltaX: number, deltaY: number) {
    this.panX -= deltaX;
    this.panY -= deltaY;
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
        looksLikePinch: this.looksLikeTouchpadPinch(event),
        looksLikePan: this.isPrecisionTouchpadPan(event),
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
    const pathElement = this.root.querySelector<HTMLSpanElement>("#current-path")!;
    pathElement.textContent = path ? this.fileNameFromPath(path) : "未打开图片";
    pathElement.title = path ?? "";
  }

  private updateStatus() {
    const statusbar = this.root.querySelector<HTMLElement>("#statusbar")!;
    const total = this.payload?.images.length ?? 0;
    const zoomLabel =
      this.mode === "single"
        ? `${Math.round(this.getCurrentSingleScale() * 100)}%`
        : "长页浏览";

    const baseText = total ? `${this.currentIndex + 1} / ${total}` : "准备就绪";
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
