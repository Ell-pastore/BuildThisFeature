import 'package:flutter/material.dart';

/// Material 3 design tokens extracted directly from the approved HTML mockup.
/// Single source of truth — never hardcode hex elsewhere.
class AppColors {
  AppColors._();

  // Brand
  static const primary            = Color(0xFF4F46E5);
  static const primaryContainer   = Color(0xFFE8E9FF);
  static const secondary          = Color(0xFF0EA5A4);
  static const secondaryContainer = Color(0xFFD8F5F4);
  static const tertiary           = Color(0xFFD946EF);
  static const tertiaryContainer  = Color(0xFFFBE5FF);

  // Status
  static const warning = Color(0xFFF59E0B);
  static const error   = Color(0xFFEF4444);
  static const success = Color(0xFF16A34A);

  // Light surfaces
  static const lightBg              = Color(0xFFFAFAFC);
  static const lightSurface         = Color(0xFFFFFFFF);
  static const lightOnSurface       = Color(0xFF1A1B25);
  static const lightOnSurface2      = Color(0xFF5B5F6C);
  static const lightOutline         = Color(0xFFE0E2EA);
  static const lightSurfaceVariant  = Color(0xFFEDEDF4);

  // Dark surfaces
  static const darkBg              = Color(0xFF0F1116);
  static const darkSurface         = Color(0xFF1A1C25);
  static const darkSurface2        = Color(0xFF232634);
  static const darkOnSurface       = Color(0xFFE9EAF2);
  static const darkOnSurface2      = Color(0xFFA4A8B6);
  static const darkOutline         = Color(0xFF2C2F3D);
  static const darkPrimary         = Color(0xFFA5A8FF);

  // File-type accents used in tiles
  static const pdfRed    = Color(0xFFEF4444);
  static const imageGreen = Color(0xFF22C55E);
  static const docBlue   = Color(0xFF3B82F6);
  static const pptPurple = Color(0xFFA855F7);
  static const xlsGreen  = Color(0xFF22C55E);
}
