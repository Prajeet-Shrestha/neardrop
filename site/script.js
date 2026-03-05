/* ─── NearDrop Site Scripts ─── */

(function () {
  'use strict';

  // ── Reveal on scroll ──
  const reveals = document.querySelectorAll('.reveal');
  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('visible');
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.15, rootMargin: '0px 0px -40px 0px' }
  );
  reveals.forEach((el) => observer.observe(el));

  // ── Tab switching (hero terminal) ──
  const tabs = document.querySelectorAll('.ht-tab');
  const panels = document.querySelectorAll('.ht-panel');

  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      const target = tab.dataset.tab;
      tabs.forEach((t) => t.classList.remove('active'));
      panels.forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('ht-' + target).classList.add('active');
    });
  });

  // ── Copy to clipboard ──
  document.querySelectorAll('.copy-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const text = btn.dataset.copy;
      navigator.clipboard.writeText(text).then(() => {
        btn.classList.add('copied');
        const svg = btn.querySelector('svg');
        const origHTML = svg.outerHTML;
        svg.outerHTML =
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
        setTimeout(() => {
          btn.classList.remove('copied');
          btn.querySelector('svg').outerHTML = origHTML;
        }, 2000);
      });
    });
  });

  // ── Smooth scroll for nav links ──
  document.querySelectorAll('a[href^="#"]').forEach((link) => {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
        // Close mobile nav if open
        document.getElementById('navLinks').classList.remove('open');
      }
    });
  });

  // ── Mobile nav toggle ──
  const toggle = document.getElementById('navToggle');
  const navLinks = document.getElementById('navLinks');
  toggle.addEventListener('click', () => {
    navLinks.classList.toggle('open');
  });

  // ── Nav scroll effect ──
  let lastScroll = 0;
  const nav = document.getElementById('nav');
  window.addEventListener(
    'scroll',
    () => {
      const currentScroll = window.pageYOffset;
      if (currentScroll > 80) {
        nav.style.background = 'rgba(7, 11, 20, 0.95)';
      } else {
        nav.style.background = 'rgba(7, 11, 20, 0.8)';
      }
      lastScroll = currentScroll;
    },
    { passive: true }
  );
})();
