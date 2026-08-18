import { useEffect, useRef } from "react";

/**
 * 剪贴板里的图片。
 * 截图工具（微信、QQ、系统截图）和网页「复制图片」给的都是 file 类型的 item，
 * 纯文字剪贴板会返回空数组，调用方据此放行默认的粘贴行为。
 */
export function clipboardImageFiles(data: DataTransfer | null | undefined): File[] {
  return Array.from(data?.items ?? [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => Boolean(file));
}

/**
 * 剪贴板里同时还带着文字吗（从 Excel、网页富文本复制时会图文都有）。
 * 这种时候图照收，但不拦默认行为，文字该落进输入框还是落进去，不平白吞掉用户的内容。
 */
export function clipboardHasText(data: DataTransfer | null | undefined) {
  return Boolean(data?.getData("text/plain")?.trim());
}

/**
 * 页面级「粘贴图片」：⌘/Ctrl + V 直接把剪贴板里的图收下，
 * 光标在描述框里也照收，不用先点某个上传框。只拦截带图片的剪贴板，粘贴纯文字照常。
 */
export function usePasteImages(onImages: (files: File[]) => void, enabled = true) {
  const handlerRef = useRef(onImages);
  handlerRef.current = onImages;

  useEffect(() => {
    if (!enabled) return;
    const handlePaste = (event: ClipboardEvent) => {
      const files = clipboardImageFiles(event.clipboardData);
      if (!files.length) return;
      if (!clipboardHasText(event.clipboardData)) event.preventDefault();
      handlerRef.current(files);
    };
    document.addEventListener("paste", handlePaste);
    return () => document.removeEventListener("paste", handlePaste);
  }, [enabled]);
}
