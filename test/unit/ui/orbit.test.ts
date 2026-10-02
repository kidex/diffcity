// orbit/* (design/mockup.html, ADR-026): the change screen's camera. Drag
// and wheel stay within the mockup's limits, scaled to the city; R returns to
// the home view from anywhere, also during the intro move.

import { describe, expect, it } from 'vitest';
import {
  HOME_PHI,
  HOME_THETA,
  homeFor,
  INTRO_FROM_RATIO,
  INTRO_MS,
  limitsFor,
  Orbit,
  orbitPosition,
  PHI_MAX,
  PHI_MIN,
  R_MIN_ABSOLUTE,
} from '../../../src/ui/screens/change/scene/orbit.js';

describe('orbit/limits', () => {
  it('scales the mockup distances to the city: 14 / 30 and 48 / 30 of home', () => {
    const home = homeFor(20);
    const limits = limitsFor(home);
    expect(limits.rMin).toBeCloseTo((home.r * 14) / 30);
    expect(limits.rMax).toBeCloseTo((home.r * 48) / 30);
    expect([limits.phiMin, limits.phiMax]).toEqual([0.35, 1.35]);
  });

  it('lets the camera come as close as R_MIN_ABSOLUTE on a large city', () => {
    expect(limitsFor(homeFor(400)).rMin).toBe(R_MIN_ABSOLUTE);
  });

  it('clamps the wheel zoom both ways', () => {
    const orbit = new Orbit(homeFor(20));
    for (let i = 0; i < 50; i += 1) orbit.zoom(-500);
    expect(orbit.state.r).toBeCloseTo(orbit.limits.rMin);
    for (let i = 0; i < 50; i += 1) orbit.zoom(500);
    expect(orbit.state.r).toBeCloseTo(orbit.limits.rMax);
  });

  it('clamps the vertical drag, leaves the horizontal one free', () => {
    const orbit = new Orbit(homeFor(20));
    orbit.drag(0, 10_000);
    expect(orbit.state.phi).toBe(PHI_MIN);
    orbit.drag(0, -10_000);
    expect(orbit.state.phi).toBe(PHI_MAX);
    orbit.drag(100, 0);
    expect(orbit.state.theta).toBeCloseTo(HOME_THETA - 0.6);
  });

  it('keeps the view within new limits when the city shrinks', () => {
    const orbit = new Orbit(homeFor(100));
    orbit.zoom(500);
    orbit.setHome(homeFor(10));
    expect(orbit.state.r).toBeLessThanOrEqual(orbit.limits.rMax);
  });
});

describe('orbit/reset', () => {
  it('returns to the home view after drag and zoom', () => {
    const home = homeFor(24);
    const orbit = new Orbit(home);
    orbit.drag(120, -40);
    orbit.zoom(300);
    expect(orbit.state).not.toEqual(home);
    orbit.reset();
    expect(orbit.state).toEqual(home);
    expect(home).toMatchObject({ theta: HOME_THETA, phi: HOME_PHI });
  });

  it('ends the intro move and goes home', () => {
    const home = homeFor(24);
    const orbit = new Orbit(home);
    orbit.startIntro(1000);
    expect(orbit.state.r).toBeCloseTo(home.r * INTRO_FROM_RATIO);
    expect(orbit.step(1000 + INTRO_MS / 2)).toBe(true);
    expect(orbit.state.r).toBeGreaterThan(home.r);
    orbit.reset();
    expect(orbit.introRunning).toBe(false);
    expect(orbit.state).toEqual(home);
    expect(orbit.step(1000 + INTRO_MS)).toBe(false);
    expect(orbit.state).toEqual(home);
  });

  it('lands the intro exactly on home', () => {
    const home = homeFor(24);
    const orbit = new Orbit(home);
    orbit.startIntro(0);
    expect(orbit.step(INTRO_MS)).toBe(false);
    expect(orbit.state).toEqual(home);
  });

  it('places the camera on the sphere around the target', () => {
    const target = { x: 3, y: 0.4, z: -2 };
    const state = homeFor(24);
    const p = orbitPosition(target, state);
    expect(Math.hypot(p.x - target.x, p.y - target.y, p.z - target.z)).toBeCloseTo(state.r);
  });
});
