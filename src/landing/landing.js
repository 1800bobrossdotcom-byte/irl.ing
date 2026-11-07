// The landing page's example feed. Real phone clips live in /samples/ and
// are listed in /samples/feed.json; slots that aren't listed keep their
// neutral tile and request nothing. Clips play muted and looping while on
// screen; with reduced motion they show their poster and play on tap.

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

function label(frame, playing) {
  frame.setAttribute("aria-label", `${playing ? "Pause" : "Play"} ${frame.dataset.handle}’s loop`);
}

function play(frame, video) {
  video.play().then(
    () => {
      frame.dataset.state = "playing";
      label(frame, true);
    },
    () => {},
  );
}

function pause(frame, video) {
  video.pause();
  delete frame.dataset.state;
  label(frame, false);
}

function attach(frame, n) {
  const video = document.createElement("video");
  Object.assign(video, { muted: true, loop: true, playsInline: true, preload: reduced ? "none" : "metadata" });
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("loop", "");
  if (!reduced) video.setAttribute("autoplay", "");
  video.poster = `/samples/feed-${n}.jpg`;
  video.src = `/samples/feed-${n}.mp4`;
  video.setAttribute("aria-hidden", "true");
  frame.append(video);
  frame.classList.add("has-clip");
  frame.setAttribute("role", "button");
  frame.tabIndex = 0;
  label(frame, false);
  let wanted = !reduced; // autoplay while visible, unless the visitor paused it
  const toggle = () => {
    if (video.paused) {
      wanted = true;
      play(frame, video);
    } else {
      wanted = false;
      pause(frame, video);
    }
  };
  frame.addEventListener("click", toggle);
  frame.addEventListener("keydown", (event) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  });
  if (!reduced) {
    new IntersectionObserver(([entry]) => (entry.isIntersecting && wanted ? play(frame, video) : pause(frame, video)), {
      threshold: 0.5,
    }).observe(frame);
  }
}

async function loadClips() {
  let clips = [];
  try {
    const res = await fetch("/samples/feed.json");
    if (res.ok) clips = (await res.json()).clips ?? [];
  } catch {
    return;
  }
  const listed = new Set(clips.map(Number));
  for (const item of document.querySelectorAll("#feed [data-clip]")) {
    const n = Number(item.dataset.clip);
    if (listed.has(n)) attach(item.querySelector(".frame"), n);
  }
}

loadClips();
