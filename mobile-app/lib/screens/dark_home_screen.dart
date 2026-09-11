import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import 'home_screen.dart' as home;

/// Screen 8 — Dark variant of the home screen.
/// Implemented as the same `HomeScreen` widget wrapped in a forced dark
/// theme so reviewers can visit it directly from the home shell.
class DarkHomeScreen extends StatelessWidget {
  const DarkHomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Theme(
      data: ThemeData(
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
        scaffoldBackgroundColor: AppColors.darkBg,
      ),
      child: const home.HomeScreen(),
    );
  }
}
