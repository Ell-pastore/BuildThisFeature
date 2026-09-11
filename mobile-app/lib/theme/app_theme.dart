import 'package:flutter/material.dart';
import 'app_colors.dart';

class AppTheme {
  AppTheme._();

  static ThemeData light() {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.light,
      colorScheme: const ColorScheme.light(
        primary: AppColors.primary,
        onPrimary: Colors.white,
        primaryContainer: AppColors.primaryContainer,
        onPrimaryContainer: AppColors.primary,
        secondary: AppColors.secondary,
        onSecondary: Colors.white,
        secondaryContainer: AppColors.secondaryContainer,
        tertiary: AppColors.tertiary,
        tertiaryContainer: AppColors.tertiaryContainer,
        error: AppColors.error,
        surface: AppColors.lightSurface,
        onSurface: AppColors.lightOnSurface,
        surfaceContainerHighest: AppColors.lightSurfaceVariant,
        outline: AppColors.lightOutline,
      ),
    );
    return _applyTypography(base).copyWith(
      scaffoldBackgroundColor: AppColors.lightBg,
    );
  }

  static ThemeData dark() {
    final base = ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.darkPrimary,
        onPrimary: Colors.black,
        primaryContainer: AppColors.darkSurface2,
        onPrimaryContainer: AppColors.darkPrimary,
        secondary: AppColors.secondary,
        onSecondary: Colors.black,
        secondaryContainer: AppColors.darkSurface2,
        tertiary: AppColors.tertiary,
        tertiaryContainer: AppColors.darkSurface2,
        error: AppColors.error,
        surface: AppColors.darkSurface,
        onSurface: AppColors.darkOnSurface,
        surfaceContainerHighest: AppColors.darkSurface2,
        outline: AppColors.darkOutline,
      ),
    );
    return _applyTypography(base).copyWith(
      scaffoldBackgroundColor: AppColors.darkBg,
    );
  }

  static ThemeData _applyTypography(ThemeData base) {
    final onSurface = base.colorScheme.onSurface;
    return base.copyWith(
      textTheme: base.textTheme.copyWith(
        displaySmall:  const TextStyle(fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -0.2),
        headlineSmall: const TextStyle(fontSize: 20, fontWeight: FontWeight.w700, letterSpacing: -0.1),
        titleLarge:    const TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
        titleMedium:   const TextStyle(fontSize: 16, fontWeight: FontWeight.w600),
        titleSmall:    const TextStyle(fontSize: 14, fontWeight: FontWeight.w600),
        bodyLarge:     const TextStyle(fontSize: 14, fontWeight: FontWeight.w500),
        bodyMedium:    const TextStyle(fontSize: 13, fontWeight: FontWeight.w500),
        bodySmall:     TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: onSurface.withOpacity(0.72)),
        labelLarge:    const TextStyle(fontSize: 13, fontWeight: FontWeight.w600),
        labelMedium:   const TextStyle(fontSize: 12, fontWeight: FontWeight.w500),
        labelSmall:    const TextStyle(fontSize: 11, fontWeight: FontWeight.w600),
      ),
      iconTheme: IconThemeData(color: onSurface, size: 22),
      splashFactory: InkSparkle.splashFactory,
    );
  }
}
