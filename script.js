// Mobile nav toggle
const btn = document.getElementById('navToggle');
const links = document.querySelector('.nav-links');
if (btn && links) {
  btn.addEventListener('click', () => {
    const open = links.classList.toggle('open');
    btn.setAttribute('aria-expanded', open);
    if (open) {
      links.style.display = 'flex';
      links.style.position = 'absolute';
      links.style.top = '60px';
      links.style.left = '0';
      links.style.right = '0';
      links.style.background = '#fff';
      links.style.flexDirection = 'column';
      links.style.padding = '16px 24px';
      links.style.borderBottom = '1px solid #e3ebe5';
    } else {
      links.removeAttribute('style');
    }
  });
}

// Smooth scroll + active link
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const id = a.getAttribute('href');
    if (id.length > 1) {
      const t = document.querySelector(id);
      if (t) {
        e.preventDefault();
        t.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });
});

// Highlight nav on scroll
const sections = document.querySelectorAll('section[id]');
const navA = document.querySelectorAll('.nav-links a');
const io = new IntersectionObserver((entries) => {
  entries.forEach(en => {
    if (en.isIntersecting) {
      const id = en.target.id;
      navA.forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + id));
    }
  });
}, { rootMargin: '-40% 0px -55% 0px' });
sections.forEach(s => io.observe(s));

// Subtle parallax on phones
const visual = document.querySelector('.hero-visual');
if (visual && window.matchMedia('(pointer:fine)').matches) {
  visual.addEventListener('mousemove', (e) => {
    const r = visual.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - 0.5;
    const y = (e.clientY - r.top) / r.height - 0.5;
    visual.querySelectorAll('.phone').forEach((p, i) => {
      const d = (i === 0 ? 6 : -6);
      p.style.transition = 'transform .15s ease';
      const base = p.classList.contains('phone-back')
        ? 'rotate(6deg) translate(35%,-5%)'
        : 'translate(-35%,10%)';
      p.style.transform = `${base} translate(${x * d}px, ${y * d}px)`;
    });
  });
  visual.addEventListener('mouseleave', () => {
    visual.querySelectorAll('.phone').forEach(p => { p.style.transform = ''; });
  });
}
