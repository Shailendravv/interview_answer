export function initStealth(): () => void {
  const stripTitles = (root: ParentNode = document): void => {
    root
      .querySelectorAll("[title]")
      .forEach((el) => el.removeAttribute("title"));
  };

  stripTitles();

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node instanceof Element) {
          if (node.hasAttribute("title")) node.removeAttribute("title");
          node.querySelectorAll("[title]").forEach((el) => el.removeAttribute("title"));
        }
      }
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });

  return () => observer.disconnect();
}
