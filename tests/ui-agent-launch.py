import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import urllib.request

from playwright.sync_api import sync_playwright

root = Path(__file__).resolve().parent.parent
artifacts = root / "tests/artifacts/agent-launch"
artifacts.mkdir(parents=True, exist_ok=True)
home = Path(tempfile.mkdtemp(prefix="web-home-", dir=artifacts))
for folder in ["Desktop", "Documents", "Downloads", ".fanbox"]:
    (home / folder).mkdir()
environment = dict(os.environ, HOME=str(home), ZDOTDIR=str(home), FANBOX_PORT="4748", FANBOX_NO_OPEN="1")
errors = []
with (artifacts / "web-server.log").open("w") as output:
    server = subprocess.Popen(["node", "server.js"], cwd=root, env=environment, stdout=output, stderr=output)
    try:
        for attempt in range(100):
            try:
                urllib.request.urlopen("http://127.0.0.1:4748", timeout=1).close()
                break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("isolated server exited")
                time.sleep(0.1)
        with sync_playwright() as playwright:
            browser = playwright.chromium.launch(headless=True)
            page = browser.new_page(viewport={"width": 1440, "height": 960})
            page.add_init_script("localStorage.setItem('fb_guided', '1')")
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto("http://127.0.0.1:4748", wait_until="networkidle")
            page.wait_for_selector("#term-agy", state="attached")
            assert page.locator("button[data-agent]").evaluate_all("buttons => buttons.map(button => button.dataset.agent)") == ["claude", "codex", "agy"]
            assert page.locator("#term-agy svg path").count() == 1
            page.evaluate("document.querySelector('#terminal-panel').classList.remove('hidden')")
            page.screenshot(path=str(artifacts / "web-defaults.png"), full_page=True)
            page.locator("#agent-config").click()
            assert not page.locator('.ap-row[data-id="t3"] input').is_checked()
            assert not page.locator('.ap-row[data-id="kimi"] input').is_checked()
            with page.expect_response(lambda response: response.url.endswith("/api/agents") and response.request.method == "POST"):
                page.locator('.ap-row[data-id="t3"] input').check()
            page.wait_for_selector("#term-t3 svg path")
            for theme in ["terminal", "warm", "editorial"]:
                page.evaluate("theme => applyTheme(theme)", theme)
                page.wait_for_timeout(600)
                page.screenshot(path=str(artifacts / f"web-{theme}.png"), full_page=True)
                for agent in ["agy", "t3"]:
                    icon = page.locator(f"#term-{agent} svg")
                    assert icon.is_visible()
                    assert icon.evaluate("element => getComputedStyle(element).fill") == icon.evaluate("element => getComputedStyle(element.parentElement).color")
            page.reload(wait_until="networkidle")
            page.wait_for_selector("#term-t3", state="attached")
            config = json.loads((home / ".fanbox/config.json").read_text())
            assert config["enabledAgents"] == ["claude", "codex", "agy", "t3"]
            assert page.evaluate("AGENT_REGISTRY.find(agent => agent.id === 'agy').cmd") == "agy --dangerously-skip-permissions"
            assert page.evaluate("AGENT_REGISTRY.find(agent => agent.id === 't3').cmd") == "t3"
            assert not errors, errors
            browser.close()
        print("Web launcher checks passed: defaults, opt-in, persistence, three themes, SVG loading, commands, no page errors")
    finally:
        server.terminate()
        server.wait(timeout=10)
