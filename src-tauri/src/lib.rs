use std::{
  fs,
  io::Write,
  path::{Path, PathBuf},
  process::Command,
  sync::Mutex,
};

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde::Serialize;
use tauri::{Emitter, Manager, PhysicalPosition, PhysicalSize, State};
#[cfg(target_os = "linux")]
use dirs::{data_local_dir, home_dir};

const SUPPORTED_EXTENSIONS: &[&str] = &[
  "jpg", "jpeg", "png", "bmp", "gif", "webp", "tif", "tiff", "ico", "heic", "svg",
];
#[cfg(target_os = "linux")]
const SUPPORTED_MIME_TYPES: &[&str] = &[
  "image/jpeg",
  "image/png",
  "image/bmp",
  "image/gif",
  "image/webp",
  "image/tiff",
  "image/x-icon",
  "image/svg+xml",
  "image/heic",
];

#[derive(Default)]
struct StartupPath(Mutex<Option<PathBuf>>);

#[derive(Default)]
struct PresentationState(Mutex<PresentationMode>);

#[derive(Default)]
struct PresentationMode {
  enabled: bool,
  previous_position: Option<PhysicalPosition<i32>>,
  previous_size: Option<PhysicalSize<u32>>,
  previous_always_on_top: Option<bool>,
  previous_maximized: Option<bool>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerPayload {
  current_path: Option<String>,
  directory: Option<String>,
  images: Vec<String>,
  supported_extensions: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssociationResult {
  platform: String,
  message: String,
  requires_manual_confirmation: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct NativeDropPayload {
  paths: Vec<String>,
}

trait PresentationHost {
  fn host_outer_position(&self) -> Result<PhysicalPosition<i32>, String>;
  fn host_outer_size(&self) -> Result<PhysicalSize<u32>, String>;
  fn host_is_always_on_top(&self) -> Result<bool, String>;
  fn host_is_maximized(&self) -> Result<bool, String>;
  fn host_maximize(&self) -> Result<(), String>;
  fn host_unmaximize(&self) -> Result<(), String>;
  fn host_set_always_on_top(&self, enabled: bool) -> Result<(), String>;
  fn host_set_fullscreen(&self, enabled: bool) -> Result<(), String>;
  fn host_set_position(&self, position: PhysicalPosition<i32>) -> Result<(), String>;
  fn host_set_size(&self, size: PhysicalSize<u32>) -> Result<(), String>;
  fn host_emit_presentation(&self, enabled: bool);
}

impl PresentationHost for tauri::Window {
  fn host_outer_position(&self) -> Result<PhysicalPosition<i32>, String> {
    self
      .outer_position()
      .map_err(|error| format!("failed to read outer position: {error}"))
  }

  fn host_outer_size(&self) -> Result<PhysicalSize<u32>, String> {
    self
      .outer_size()
      .map_err(|error| format!("failed to read outer size: {error}"))
  }

  fn host_is_always_on_top(&self) -> Result<bool, String> {
    self
      .is_always_on_top()
      .map_err(|error| format!("failed to read always-on-top state: {error}"))
  }

  fn host_is_maximized(&self) -> Result<bool, String> {
    self
      .is_maximized()
      .map_err(|error| format!("failed to read maximize state: {error}"))
  }

  fn host_maximize(&self) -> Result<(), String> {
    self.maximize().map_err(|error| format!("failed to maximize window: {error}"))
  }

  fn host_unmaximize(&self) -> Result<(), String> {
    self
      .unmaximize()
      .map_err(|error| format!("failed to unmaximize window: {error}"))
  }

  fn host_set_always_on_top(&self, enabled: bool) -> Result<(), String> {
    self
      .set_always_on_top(enabled)
      .map_err(|error| format!("failed to set always-on-top state: {error}"))
  }

  fn host_set_fullscreen(&self, enabled: bool) -> Result<(), String> {
    self
      .set_fullscreen(enabled)
      .map_err(|error| format!("failed to set fullscreen state: {error}"))
  }

  fn host_set_position(&self, position: PhysicalPosition<i32>) -> Result<(), String> {
    self
      .set_position(position)
      .map_err(|error| format!("failed to set window position: {error}"))
  }

  fn host_set_size(&self, size: PhysicalSize<u32>) -> Result<(), String> {
    self
      .set_size(size)
      .map_err(|error| format!("failed to set window size: {error}"))
  }

  fn host_emit_presentation(&self, enabled: bool) {
    emit_presentation_mode(self, enabled);
  }
}

impl<R: tauri::Runtime> PresentationHost for tauri::WebviewWindow<R> {
  fn host_outer_position(&self) -> Result<PhysicalPosition<i32>, String> {
    self
      .outer_position()
      .map_err(|error| format!("failed to read outer position: {error}"))
  }

  fn host_outer_size(&self) -> Result<PhysicalSize<u32>, String> {
    self
      .outer_size()
      .map_err(|error| format!("failed to read outer size: {error}"))
  }

  fn host_is_always_on_top(&self) -> Result<bool, String> {
    self
      .is_always_on_top()
      .map_err(|error| format!("failed to read always-on-top state: {error}"))
  }

  fn host_is_maximized(&self) -> Result<bool, String> {
    self
      .is_maximized()
      .map_err(|error| format!("failed to read maximize state: {error}"))
  }

  fn host_maximize(&self) -> Result<(), String> {
    self.maximize().map_err(|error| format!("failed to maximize window: {error}"))
  }

  fn host_unmaximize(&self) -> Result<(), String> {
    self
      .unmaximize()
      .map_err(|error| format!("failed to unmaximize window: {error}"))
  }

  fn host_set_always_on_top(&self, enabled: bool) -> Result<(), String> {
    self
      .set_always_on_top(enabled)
      .map_err(|error| format!("failed to set always-on-top state: {error}"))
  }

  fn host_set_fullscreen(&self, enabled: bool) -> Result<(), String> {
    self
      .set_fullscreen(enabled)
      .map_err(|error| format!("failed to set fullscreen state: {error}"))
  }

  fn host_set_position(&self, position: PhysicalPosition<i32>) -> Result<(), String> {
    self
      .set_position(position)
      .map_err(|error| format!("failed to set window position: {error}"))
  }

  fn host_set_size(&self, size: PhysicalSize<u32>) -> Result<(), String> {
    self
      .set_size(size)
      .map_err(|error| format!("failed to set window size: {error}"))
  }

  fn host_emit_presentation(&self, enabled: bool) {
    append_native_log("presentation-mode", &enabled.to_string());
    let _ = self.emit("see://presentation-mode", enabled);
  }
}

fn append_native_log(label: &str, message: &str) {
  let log_path = std::env::temp_dir().join("see-debug.log");
  if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(log_path) {
    let _ = writeln!(file, "[native:{label}] {message}");
  }
}

#[tauri::command]
fn get_startup_payload(state: State<'_, StartupPath>) -> Result<ViewerPayload, String> {
  let startup_path = state
    .0
    .lock()
    .map_err(|_| "failed to read startup state".to_string())?
    .clone();

  append_native_log("get_startup_payload", &format!("startup_path={startup_path:?}"));
  Ok(build_payload(startup_path.and_then(resolve_input_path)))
}

#[tauri::command]
fn get_payload_for_path(path: String) -> Result<ViewerPayload, String> {
  append_native_log("get_payload_for_path", &path);
  let path_buf = resolve_input_path(PathBuf::from(path)).ok_or_else(|| "path does not exist".to_string())?;
  Ok(build_payload(Some(path_buf)))
}

#[tauri::command]
fn read_image_data_url(path: String) -> Result<String, String> {
  append_native_log("read_image_data_url", &path);
  let path_buf = resolve_input_path(PathBuf::from(&path)).unwrap_or_else(|| PathBuf::from(path));
  let bytes = fs::read(&path_buf).map_err(|error| format!("failed to read image bytes: {error}"))?;
  let mime = mime_from_path(&path_buf);
  Ok(format!("data:{mime};base64,{}", STANDARD.encode(bytes)))
}

#[tauri::command]
fn append_debug_log(label: String, message: String) -> Result<(), String> {
  append_native_log(&label, &message);
  let log_path = std::env::temp_dir().join("see-debug.log");
  let mut file = fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&log_path)
    .map_err(|error| format!("failed to open debug log: {error}"))?;
  writeln!(file, "[{label}] {message}").map_err(|error| format!("failed to write debug log: {error}"))?;
  Ok(())
}

#[tauri::command]
fn delete_image_file(path: String, permanently: bool) -> Result<(), String> {
  append_native_log("delete_image_file", &format!("path={path}, permanently={permanently}"));
  let path_buf = resolve_input_path(PathBuf::from(&path)).unwrap_or_else(|| PathBuf::from(&path));
  if !path_buf.exists() {
    return Err(format!("文件不存在: {}", path));
  }

  if permanently {
    fs::remove_file(&path_buf).map_err(|error| format!("彻底删除失败: {error}"))?;
  } else {
    trash::delete(&path_buf).map_err(|error| format!("移至回收站失败: {error}"))?;
  }

  Ok(())
}

#[tauri::command]
fn start_window_drag(window: tauri::Window) -> Result<(), String> {
  window
    .start_dragging()
    .map_err(|error| format!("failed to start drag: {error}"))
}

#[tauri::command]
fn minimize_window(window: tauri::Window) -> Result<(), String> {
  window
    .minimize()
    .map_err(|error| format!("failed to minimize window: {error}"))
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::Window) -> Result<(), String> {
  let is_maximized = window
    .is_maximized()
    .map_err(|error| format!("failed to read maximize state: {error}"))?;
  if is_maximized {
    window
      .unmaximize()
      .map_err(|error| format!("failed to unmaximize window: {error}"))
  } else {
    window
      .maximize()
      .map_err(|error| format!("failed to maximize window: {error}"))
  }
}

#[tauri::command]
fn close_window(window: tauri::Window) -> Result<(), String> {
  window
    .close()
    .map_err(|error| format!("failed to close window: {error}"))
}

#[tauri::command]
fn is_presentation_mode(state: State<'_, PresentationState>) -> Result<bool, String> {
  Ok(
    state
      .0
      .lock()
      .map_err(|_| "failed to read presentation state".to_string())?
      .enabled,
  )
}

#[tauri::command]
fn toggle_presentation_mode(
  window: tauri::Window,
  state: State<'_, PresentationState>,
) -> Result<bool, String> {
  let next = {
    let guard = state
      .0
      .lock()
      .map_err(|_| "failed to read presentation state".to_string())?;
    !guard.enabled
  };

  apply_presentation_mode(&window, &state, next)
}

#[tauri::command]
fn prepare_default_app_integration() -> Result<AssociationResult, String> {
  #[cfg(target_os = "windows")]
  {
    prepare_windows_file_associations()?;
    open_default_apps_settings()?;
    return Ok(AssociationResult {
      platform: "windows".to_string(),
      message: "已把 See 注册到当前用户的图片打开方式列表，并打开 See 的默认应用设置页。Windows 对 .jpg/.jpeg 等格式仍需要你在系统页里确认一次默认应用。".to_string(),
      requires_manual_confirmation: true,
    });
  }

  #[cfg(target_os = "linux")]
  {
    install_linux_desktop_entry()?;
    open_linux_default_app_settings();
    return Ok(AssociationResult {
      platform: "linux".to_string(),
      message: "已写入 See 的 desktop entry，并尝试设置常见图片 MIME 的默认应用。部分桌面环境仍可能需要你在系统设置里确认。".to_string(),
      requires_manual_confirmation: true,
    });
  }

  #[cfg(target_os = "macos")]
  {
    open_macos_default_app_settings()?;
    return Ok(AssociationResult {
      platform: "macos".to_string(),
      message: "已打开 macOS 设置入口。打包后的 See 会带图片文档类型声明，最终默认打开方式通常仍需你在 Finder 里确认。".to_string(),
      requires_manual_confirmation: true,
    });
  }

  #[allow(unreachable_code)]
  Err("当前平台暂不支持自动配置默认图片查看器".to_string())
}

fn build_payload(startup_path: Option<PathBuf>) -> ViewerPayload {
  let current_path = startup_path
    .clone()
    .and_then(|path| path.canonicalize().ok().or(Some(path)))
    .unwrap_or_default();

  let directory = current_path.parent().map(Path::to_path_buf);
  let images = directory
    .as_ref()
    .map(|directory_path| collect_images(directory_path))
    .unwrap_or_default();

  ViewerPayload {
    current_path: if current_path.as_os_str().is_empty() {
      None
    } else {
      normalize_path(&current_path)
    },
    directory: directory.and_then(|path| normalize_path(&path)),
    images,
    supported_extensions: SUPPORTED_EXTENSIONS.iter().map(|item| item.to_string()).collect(),
  }
}

fn normalize_path(path: &Path) -> Option<String> {
  path.canonicalize()
    .ok()
    .or_else(|| Some(path.to_path_buf()))
    .map(|item| sanitize_path_for_webview(&item))
}

fn sanitize_path_for_webview(path: &Path) -> String {
  let raw = path.to_string_lossy().to_string();

  #[cfg(target_os = "windows")]
  {
    return strip_windows_verbatim_prefix(&raw);
  }

  #[allow(unreachable_code)]
  raw
}

#[cfg(target_os = "windows")]
fn strip_windows_verbatim_prefix(path: &str) -> String {
  if let Some(stripped) = path.strip_prefix(r"\\?\UNC\") {
    return format!(r"\\{stripped}");
  }

  if let Some(stripped) = path.strip_prefix(r"\\?\") {
    return stripped.to_string();
  }

  path.to_string()
}

fn mime_from_path(path: &Path) -> &'static str {
  let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
  if ext.eq_ignore_ascii_case("jpg") || ext.eq_ignore_ascii_case("jpeg") {
    "image/jpeg"
  } else if ext.eq_ignore_ascii_case("png") {
    "image/png"
  } else if ext.eq_ignore_ascii_case("webp") {
    "image/webp"
  } else if ext.eq_ignore_ascii_case("gif") {
    "image/gif"
  } else if ext.eq_ignore_ascii_case("bmp") {
    "image/bmp"
  } else if ext.eq_ignore_ascii_case("svg") {
    "image/svg+xml"
  } else if ext.eq_ignore_ascii_case("ico") {
    "image/x-icon"
  } else if ext.eq_ignore_ascii_case("tif") || ext.eq_ignore_ascii_case("tiff") {
    "image/tiff"
  } else if ext.eq_ignore_ascii_case("heic") {
    "image/heic"
  } else {
    "application/octet-stream"
  }
}

fn collect_images(directory: &Path) -> Vec<String> {
  let mut files: Vec<PathBuf> = match fs::read_dir(directory) {
    Ok(entries) => entries
      .filter_map(|entry| entry.ok().map(|item| item.path()))
      .filter(|path| path.is_file() && is_supported_image(path))
      .collect(),
    Err(_) => Vec::new(),
  };

  files.sort_by(|a, b| natord(a, b));
  files.into_iter().filter_map(|path| normalize_path(&path)).collect()
}

fn natord(left: &Path, right: &Path) -> std::cmp::Ordering {
  let left_name = left
    .file_name()
    .map(|item| item.to_string_lossy().to_string())
    .unwrap_or_default();
  let right_name = right
    .file_name()
    .map(|item| item.to_string_lossy().to_string())
    .unwrap_or_default();

  natural_compare(&left_name, &right_name)
}

fn natural_compare(left: &str, right: &str) -> std::cmp::Ordering {
  let mut left_iter = left.chars().peekable();
  let mut right_iter = right.chars().peekable();

  loop {
    match (left_iter.peek().copied(), right_iter.peek().copied()) {
      (None, None) => return std::cmp::Ordering::Equal,
      (None, Some(_)) => return std::cmp::Ordering::Less,
      (Some(_), None) => return std::cmp::Ordering::Greater,
      (Some(left_char), Some(right_char)) => {
        if left_char.is_ascii_digit() && right_char.is_ascii_digit() {
          let left_chunk = collect_digit_chunk(&mut left_iter);
          let right_chunk = collect_digit_chunk(&mut right_iter);
          let ordering = compare_numeric_chunks(&left_chunk, &right_chunk);
          if ordering != std::cmp::Ordering::Equal {
            return ordering;
          }
          continue;
        }

        let left_char = left_iter.next().unwrap_or_default();
        let right_char = right_iter.next().unwrap_or_default();
        let left_folded = left_char.to_ascii_lowercase();
        let right_folded = right_char.to_ascii_lowercase();

        match left_folded.cmp(&right_folded) {
          std::cmp::Ordering::Equal => {
            if left_char != right_char {
              let case_order = left_char.cmp(&right_char);
              if case_order != std::cmp::Ordering::Equal {
                return case_order;
              }
            }
          }
          other => return other,
        }
      }
    }
  }
}

fn collect_digit_chunk<I>(chars: &mut std::iter::Peekable<I>) -> String
where
  I: Iterator<Item = char>,
{
  let mut chunk = String::new();
  while let Some(next) = chars.peek().copied() {
    if !next.is_ascii_digit() {
      break;
    }
    chunk.push(next);
    chars.next();
  }
  chunk
}

fn compare_numeric_chunks(left: &str, right: &str) -> std::cmp::Ordering {
  let left_trimmed = left.trim_start_matches('0');
  let right_trimmed = right.trim_start_matches('0');
  let left_significant = if left_trimmed.is_empty() { "0" } else { left_trimmed };
  let right_significant = if right_trimmed.is_empty() { "0" } else { right_trimmed };

  match left_significant.len().cmp(&right_significant.len()) {
    std::cmp::Ordering::Equal => match left_significant.cmp(right_significant) {
      std::cmp::Ordering::Equal => left.len().cmp(&right.len()),
      other => other,
    },
    other => other,
  }
}

fn emit_native_drop(window: &tauri::Window, paths: &[PathBuf]) {
  let payload = NativeDropPayload {
    paths: paths.iter().filter_map(|path| normalize_path(path)).collect(),
  };

  append_native_log("native-drop", &format!("{:?}", payload.paths));
  let _ = window.emit("see://native-drop", payload);
}

fn emit_presentation_mode(window: &tauri::Window, enabled: bool) {
  append_native_log("presentation-mode", &enabled.to_string());
  let _ = window.emit("see://presentation-mode", enabled);
}

fn open_drop_paths_js<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>, paths: &[PathBuf]) {
  let payload = NativeDropPayload {
    paths: paths.iter().filter_map(|path| normalize_path(path)).collect(),
  };

  if let Ok(json) = serde_json::to_string(&payload.paths) {
    let _ = window.eval(format!(
      "window.__SEE_OPEN_DROPPED_PATHS__ && window.__SEE_OPEN_DROPPED_PATHS__({json});"
    ));
  }
}

fn apply_presentation_mode<T: PresentationHost>(
  window: &T,
  state: &State<'_, PresentationState>,
  next: bool,
) -> Result<bool, String> {
  let mut guard = state
    .0
    .lock()
    .map_err(|_| "failed to write presentation state".to_string())?;

  if guard.enabled == next {
    window.host_emit_presentation(guard.enabled);
    return Ok(guard.enabled);
  }

  if next {
    guard.previous_position = Some(window.host_outer_position()?);
    guard.previous_size = Some(window.host_outer_size()?);
    guard.previous_always_on_top = Some(window.host_is_always_on_top()?);
    let was_maximized = window.host_is_maximized()?;
    guard.previous_maximized = Some(was_maximized);

    window.host_set_always_on_top(false)?;
    if was_maximized {
      window.host_unmaximize()?;
    }
    window.host_set_fullscreen(true)?;
  } else {
    let was_maximized = guard.previous_maximized.take().unwrap_or(false);
    let _ = window.host_set_fullscreen(false);
    if let Some(always_on_top) = guard.previous_always_on_top.take() {
      let _ = window.host_set_always_on_top(always_on_top);
    }
    if !was_maximized {
      if let Some(position) = guard.previous_position.take() {
        let _ = window.host_set_position(position);
      }
      if let Some(size) = guard.previous_size.take() {
        let _ = window.host_set_size(size);
      }
    } else {
      guard.previous_position = None;
      guard.previous_size = None;
      let _ = window.host_maximize();
    }
  }

  guard.enabled = next;
  window.host_emit_presentation(next);
  Ok(next)
}

#[cfg(test)]
mod tests {
  use super::natural_compare;
  use std::cmp::Ordering;

  #[test]
  fn sorts_numeric_suffixes_naturally() {
    assert_eq!(natural_compare("image2.jpg", "image10.jpg"), Ordering::Less);
    assert_eq!(natural_compare("image12.jpg", "image3.jpg"), Ordering::Greater);
  }

  #[test]
  fn keeps_plain_text_comparison_case_insensitive_first() {
    assert_eq!(natural_compare("Beach.png", "beach.png"), Ordering::Less);
    assert_eq!(natural_compare("alpha", "Beta"), Ordering::Less);
  }

  #[test]
  fn compares_zero_padded_numbers_stably() {
    assert_eq!(natural_compare("frame001.png", "frame1.png"), Ordering::Greater);
    assert_eq!(natural_compare("frame0002.png", "frame0010.png"), Ordering::Less);
  }

  #[test]
  fn test_delete_image_file_not_found() {
    let result = super::delete_image_file("non_existent_file_12345.png".to_string(), false);
    assert!(result.is_err());
  }

  #[test]
  fn test_delete_image_file_permanently() {
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join("test_see_permanent_del.png");
    std::fs::write(&file_path, b"test").unwrap();
    assert!(file_path.exists());

    let result = super::delete_image_file(file_path.to_string_lossy().to_string(), true);
    assert!(result.is_ok());
    assert!(!file_path.exists());
  }

  #[test]
  fn test_delete_image_file_to_trash() {
    let temp_dir = std::env::temp_dir();
    let file_path = temp_dir.join("test_see_trash_del.png");
    std::fs::write(&file_path, b"test").unwrap();
    assert!(file_path.exists());

    let result = super::delete_image_file(file_path.to_string_lossy().to_string(), false);
    assert!(result.is_ok());
    assert!(!file_path.exists());
  }

  #[test]
  fn test_decode_file_url_ascii_and_utf8() {
    let ascii_url = "file:///C:/Users/test/photo.jpg";
    assert_eq!(
      super::decode_file_url(ascii_url),
      Some("C:\\Users\\test\\photo.jpg".to_string())
    );

    let chinese_url = "file:///D:/%E7%85%A7%E7%89%87/%E9%A3%8E%E6%99%AF.png";
    assert_eq!(
      super::decode_file_url(chinese_url),
      Some("D:\\照片\\风景.png".to_string())
    );
  }

  #[test]
  fn test_is_supported_image() {
    assert!(super::is_supported_image(std::path::Path::new("a.JPG")));
    assert!(super::is_supported_image(std::path::Path::new("b.png")));
    assert!(super::is_supported_image(std::path::Path::new("c.webp")));
    assert!(!super::is_supported_image(std::path::Path::new("d.txt")));
    assert!(!super::is_supported_image(std::path::Path::new("e.exe")));
  }
}

pub fn run() {
  append_native_log("run", &format!("args={:?}", std::env::args_os().collect::<Vec<_>>()));
  let startup_path = std::env::args_os()
    .skip(1)
    .map(PathBuf::from)
    .find_map(resolve_input_path);
  append_native_log("resolved_startup_path", &format!("{startup_path:?}"));

  tauri::Builder::default()
    .manage(StartupPath(Mutex::new(startup_path)))
    .manage(PresentationState::default())
    .on_window_event(|window, event| {
      if let tauri::WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, .. }) = event {
        emit_native_drop(window, paths);
        if let Some(webview_window) = window.app_handle().get_webview_window(window.label()) {
          open_drop_paths_js(&webview_window, paths);
        }
      }
    })
    .invoke_handler(tauri::generate_handler![
      get_startup_payload,
      get_payload_for_path,
      read_image_data_url,
      append_debug_log,
      start_window_drag,
      minimize_window,
      toggle_maximize_window,
      is_presentation_mode,
      toggle_presentation_mode,
      close_window,
      prepare_default_app_integration,
      delete_image_file
    ])
    .setup(|app| {
      if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_title("See");
        let _ = window.show();
        let _ = window.set_focus();
        // 强制窗口置顶再取消，确保系统能把焦点抢过来，不被压在下面
        let _ = window.set_always_on_top(true);
        let _ = window.set_always_on_top(false);
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

fn resolve_input_path(path: PathBuf) -> Option<PathBuf> {
  if path.exists() {
    if is_supported_image(&path) {
      return Some(path);
    }
    if path.is_dir() {
      let images = collect_images(&path);
      if let Some(first) = images.first() {
        return Some(PathBuf::from(first));
      }
    }
  }

  let raw = path.to_string_lossy().trim().trim_matches('"').to_string();
  if raw.is_empty() {
    return None;
  }

  if let Some(decoded) = decode_file_url(&raw) {
    let decoded_path = PathBuf::from(decoded);
    if decoded_path.exists() {
      if is_supported_image(&decoded_path) {
        return Some(decoded_path);
      }
      if decoded_path.is_dir() {
        let images = collect_images(&decoded_path);
        if let Some(first) = images.first() {
          return Some(PathBuf::from(first));
        }
      }
    }
  }

  let normalized = PathBuf::from(&raw);
  if normalized.exists() {
    if is_supported_image(&normalized) {
      return Some(normalized);
    }
    if normalized.is_dir() {
      let images = collect_images(&normalized);
      if let Some(first) = images.first() {
        return Some(PathBuf::from(first));
      }
    }
  }

  None
}

fn decode_file_url(raw: &str) -> Option<String> {
  let lower = raw.to_ascii_lowercase();
  if !lower.starts_with("file://") {
    return None;
  }

  let mut body = raw[7..].replace('/', "\\");
  if body.starts_with('\\') && body.chars().nth(2) == Some(':') {
    body.remove(0);
  }

  let bytes = body.as_bytes();
  let mut decoded_bytes = Vec::with_capacity(bytes.len());
  let mut index = 0;
  while index < bytes.len() {
    if bytes[index] == b'%' && index + 2 < bytes.len() {
      if let Ok(hex) = std::str::from_utf8(&bytes[index + 1..index + 3]) {
        if let Ok(value) = u8::from_str_radix(hex, 16) {
          decoded_bytes.push(value);
          index += 3;
          continue;
        }
      }
    }

    decoded_bytes.push(bytes[index]);
    index += 1;
  }

  String::from_utf8(decoded_bytes).ok()
}

fn is_supported_image(path: &Path) -> bool {
  let ext = path.extension().and_then(|ext| ext.to_str()).unwrap_or("");
  SUPPORTED_EXTENSIONS.iter().any(|supported| ext.eq_ignore_ascii_case(supported))
}

#[cfg(target_os = "windows")]
fn prepare_windows_file_associations() -> Result<(), String> {
  use winreg::{enums::HKEY_CURRENT_USER, RegKey};

  let exe_path = windows_association_executable()?;
  let exe_string = exe_path.to_string_lossy().to_string();
  let hkcu = RegKey::predef(HKEY_CURRENT_USER);
  let classes = hkcu
    .create_subkey("Software\\Classes")
    .map_err(|error| format!("failed to create HKCU classes root: {error}"))?
    .0;

  let (prog_id, _) = classes
    .create_subkey("See.Image")
    .map_err(|error| format!("failed to create ProgID: {error}"))?;
  prog_id
    .set_value("", &"See Image Viewer")
    .map_err(|error| format!("failed to set ProgID name: {error}"))?;

  let (default_icon, _) = prog_id
    .create_subkey("DefaultIcon")
    .map_err(|error| format!("failed to create icon key: {error}"))?;
  default_icon
    .set_value("", &format!("{exe_string},0"))
    .map_err(|error| format!("failed to set icon: {error}"))?;

  let (command_key, _) = prog_id
    .create_subkey("shell\\open\\command")
    .map_err(|error| format!("failed to create open command key: {error}"))?;
  command_key
    .set_value("", &format!("\"{exe_string}\" \"%1\""))
    .map_err(|error| format!("failed to set open command: {error}"))?;

  for ext in SUPPORTED_EXTENSIONS {
    let (ext_key, _) = classes
      .create_subkey(format!(".{ext}\\OpenWithProgids"))
      .map_err(|error| format!("failed to create extension key for .{ext}: {error}"))?;
    ext_key
      .set_value("See.Image", &"")
      .map_err(|error| format!("failed to register .{ext}: {error}"))?;

    let (fallback_key, _) = classes
      .create_subkey(format!(".{ext}"))
      .map_err(|error| format!("failed to create extension root for .{ext}: {error}"))?;
    let current_default: String = fallback_key.get_value("").unwrap_or_default();
    if current_default.is_empty() || current_default == "See.Image" {
      fallback_key
        .set_value("", &"See.Image")
        .map_err(|error| format!("failed to set fallback ProgID for .{ext}: {error}"))?;
    }
  }

  let (capabilities, _) = hkcu
    .create_subkey("Software\\See\\Capabilities")
    .map_err(|error| format!("failed to create capabilities key: {error}"))?;
  capabilities
    .set_value("ApplicationName", &"See")
    .map_err(|error| format!("failed to set app name: {error}"))?;
  capabilities
    .set_value("ApplicationDescription", &"Lightweight image viewer")
    .map_err(|error| format!("failed to set app description: {error}"))?;

  let (file_associations, _) = capabilities
    .create_subkey("FileAssociations")
    .map_err(|error| format!("failed to create file associations key: {error}"))?;
  for ext in SUPPORTED_EXTENSIONS {
    file_associations
      .set_value(format!(".{ext}"), &"See.Image")
      .map_err(|error| format!("failed to map .{ext} capability: {error}"))?;
  }

  let (registered_apps, _) = hkcu
    .create_subkey("Software\\RegisteredApplications")
    .map_err(|error| format!("failed to create registered applications key: {error}"))?;
  registered_apps
    .set_value("See", &"Software\\See\\Capabilities")
    .map_err(|error| format!("failed to register application capabilities: {error}"))?;

  // Also register under Applications\see.exe for Windows Explorer Open-With compatibility
  let (app_key, _) = classes
    .create_subkey("Applications\\see.exe\\shell\\open\\command")
    .map_err(|error| format!("failed to create Applications open command: {error}"))?;
  app_key
    .set_value("", &format!("\"{exe_string}\" \"%1\""))
    .map_err(|error| format!("failed to set Applications open command: {error}"))?;

  let (app_types, _) = classes
    .create_subkey("Applications\\see.exe\\SupportedTypes")
    .map_err(|error| format!("failed to create SupportedTypes: {error}"))?;
  for ext in SUPPORTED_EXTENSIONS {
    let _ = app_types.set_value(format!(".{ext}"), &"");
  }

  // Register in App Paths for direct execution via 'see.exe'
  let (app_paths, _) = hkcu
    .create_subkey("Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\see.exe")
    .map_err(|error| format!("failed to create App Paths: {error}"))?;
  app_paths
    .set_value("", &exe_string)
    .map_err(|error| format!("failed to set App Paths: {error}"))?;

  Ok(())
}

#[cfg(target_os = "windows")]
fn windows_association_executable() -> Result<PathBuf, String> {
  let current_exe =
    std::env::current_exe().map_err(|error| format!("failed to locate executable: {error}"))?;

  if !cfg!(debug_assertions) {
    return Ok(current_exe);
  }

  let release_candidate = current_exe
    .parent()
    .and_then(Path::parent)
    .map(|target_dir| target_dir.join("release").join("see.exe"))
    .filter(|path| path.exists());

  if let Some(release_exe) = release_candidate {
    return Ok(release_exe);
  }

  Err(
    "当前是开发版 See。请先执行一次 tauri build 生成 release 版本，再点击“设为默认”完成系统关联。"
      .to_string(),
  )
}

#[cfg(target_os = "windows")]
fn open_default_apps_settings() -> Result<(), String> {
  let deep_link = "ms-settings:defaultapps?registeredAppUser=See";
  Command::new("cmd")
    .args(["/C", "start", "", deep_link])
    .spawn()
    .or_else(|_| Command::new("cmd").args(["/C", "start", "", "ms-settings:defaultapps"]).spawn())
    .map_err(|error| format!("failed to open default apps settings: {error}"))?;
  Ok(())
}

#[cfg(target_os = "linux")]
fn install_linux_desktop_entry() -> Result<(), String> {
  let applications_dir = data_local_dir()
    .or_else(|| home_dir().map(|home| home.join(".local").join("share")))
    .map(|path| path.join("applications"))
    .ok_or_else(|| "failed to locate local applications directory".to_string())?;
  fs::create_dir_all(&applications_dir)
    .map_err(|error| format!("failed to create applications directory: {error}"))?;

  let desktop_file_path = applications_dir.join("see.desktop");
  let executable =
    std::env::current_exe().map_err(|error| format!("failed to locate executable: {error}"))?;
  let mut desktop_file =
    fs::File::create(&desktop_file_path).map_err(|error| format!("failed to create desktop entry: {error}"))?;
  let mime_types = SUPPORTED_MIME_TYPES.join(";");
  let content = format!(
    "[Desktop Entry]\nType=Application\nName=See\nExec=\"{}\" %f\nTerminal=false\nCategories=Graphics;Viewer;\nMimeType={};\nNoDisplay=false\n",
    executable.to_string_lossy(),
    mime_types
  );
  desktop_file
    .write_all(content.as_bytes())
    .map_err(|error| format!("failed to write desktop entry: {error}"))?;

  let _ = Command::new("update-desktop-database")
    .arg(&applications_dir)
    .status();
  let _ = Command::new("gio")
    .args([
      "set",
      desktop_file_path.to_string_lossy().as_ref(),
      "metadata::trusted",
      "true",
    ])
    .status();

  for mime in SUPPORTED_MIME_TYPES {
    let _ = Command::new("xdg-mime")
      .args(["default", "see.desktop", mime])
      .status();
  }

  Ok(())
}

#[cfg(target_os = "linux")]
fn open_linux_default_app_settings() {
  for command in [
    vec!["gnome-control-center", "default-applications"],
    vec!["kcmshell6", "componentchooser"],
    vec!["kcmshell5", "componentchooser"],
  ] {
    if let Some((program, args)) = command.split_first() {
      if Command::new(program).args(args).spawn().is_ok() {
        break;
      }
    }
  }
}

#[cfg(target_os = "macos")]
fn open_macos_default_app_settings() -> Result<(), String> {
  let candidates = [
    vec!["-b", "com.apple.systempreferences"],
    vec!["x-apple.systempreferences:com.apple.ExtensionsPreferences"],
  ];

  for args in candidates {
    if Command::new("open").args(args).spawn().is_ok() {
      return Ok(());
    }
  }

  Err("failed to open macOS settings".to_string())
}
