import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/common_widgets.dart';

class SettingsScreen extends StatefulWidget {
  final ThemeMode themeMode;
  final ValueChanged<ThemeMode> onThemeModeChanged;

  const SettingsScreen({
    super.key,
    required this.themeMode,
    required this.onThemeModeChanged,
  });

  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface2 = isDark ? AppColors.darkOnSurface2 : const Color(0xFF8E92A0);

    String appearanceLabel;
    switch (widget.themeMode) {
      case ThemeMode.light:
        appearanceLabel = 'Light';
        break;
      case ThemeMode.dark:
        appearanceLabel = 'Dark';
        break;
      case ThemeMode.system:
        appearanceLabel = 'System';
        break;
    }

    return Scaffold(
      appBar: AppBar(
        title: const Text('Settings'),
        actions: [
          IconButton(onPressed: () {}, icon: const Icon(Icons.tune)),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 100),
        children: [
          const SectionHeader(title: 'AI & Privacy'),
          _SettingsGroup(
            surface: surface,
            outline: outline,
            children: [
              _SettingsRow(
                icon: Icons.lock_outline,
                iconBg: isDark
                    ? AppColors.darkPrimary.withValues(alpha: 0.2)
                    : AppColors.primaryContainer,
                iconColor: isDark ? AppColors.darkPrimary : AppColors.primary,
                title: 'On-device mode',
                subtitle: 'AI runs locally, nothing leaves your phone',
                trailing: Switch(
                  value: true,
                  onChanged: (_) {},
                  activeThumbColor: AppColors.primary,
                ),
                onSurface2: onSurface2,
              ),
              _SettingsRow(
                icon: Icons.auto_awesome,
                iconBg: isDark
                    ? const Color(0xFF14532D)
                    : const Color(0xFFDCFCE7),
                iconColor: isDark
                    ? const Color(0xFF86EFAC)
                    : AppColors.success,
                title: 'AI model',
                subtitle: 'FileMind v3 · 4 GB',
                trailing: Icon(Icons.chevron_right, color: onSurface2),
                onSurface2: onSurface2,
              ),
              _SettingsRow(
                icon: Icons.folder_outlined,
                iconBg: isDark
                    ? const Color(0xFF78350F)
                    : const Color(0xFFFFEDD5),
                iconColor: isDark
                    ? const Color(0xFFFBBF24)
                    : AppColors.warning,
                title: 'Allowed paths',
                subtitle: 'Documents · Downloads · DCIM',
                trailing: Icon(Icons.chevron_right, color: onSurface2),
                onSurface2: onSurface2,
              ),
            ],
          ),

          const SectionHeader(title: 'Automation'),
          _SettingsGroup(
            surface: surface,
            outline: outline,
            children: [
              _SettingsRow(
                icon: Icons.schedule,
                iconBg: isDark
                    ? AppColors.darkPrimary.withValues(alpha: 0.2)
                    : AppColors.primaryContainer,
                iconColor: isDark ? AppColors.darkPrimary : AppColors.primary,
                title: 'Auto-organize weekly',
                subtitle: 'Every Sunday at 9 PM',
                trailing: Switch(
                  value: true,
                  onChanged: (_) {},
                  activeThumbColor: AppColors.primary,
                ),
                onSurface2: onSurface2,
              ),
              _SettingsRow(
                icon: Icons.list_alt,
                iconBg: isDark
                    ? const Color(0xFF14532D)
                    : const Color(0xFFDCFCE7),
                iconColor: isDark
                    ? const Color(0xFF86EFAC)
                    : AppColors.success,
                title: 'Auto-delete duplicates',
                subtitle: 'Confirm before deletion',
                trailing: Switch(
                  value: false,
                  onChanged: (_) {},
                  activeThumbColor: AppColors.primary,
                ),
                onSurface2: onSurface2,
              ),
            ],
          ),

          const SectionHeader(title: 'General'),
          _SettingsGroup(
            surface: surface,
            outline: outline,
            children: [
              InkWell(
                onTap: () => _showAppearancePicker(context),
                child: _SettingsRow(
                  icon: Icons.brightness_6_outlined,
                  iconBg: isDark
                      ? AppColors.darkPrimary.withValues(alpha: 0.2)
                      : AppColors.primaryContainer,
                  iconColor: isDark ? AppColors.darkPrimary : AppColors.primary,
                  title: 'Appearance',
                  subtitle: appearanceLabel,
                  trailing: Icon(Icons.chevron_right, color: onSurface2),
                  onSurface2: onSurface2,
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  void _showAppearancePicker(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;

    showModalBottomSheet(
      context: context,
      backgroundColor: surface,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (ctx) {
        return SafeArea(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              const SizedBox(height: 12),
              Container(
                width: 36,
                height: 4,
                decoration: BoxDecoration(
                  color: Colors.grey,
                  borderRadius: BorderRadius.circular(99),
                ),
              ),
              const SizedBox(height: 16),
              const Text(
                'Appearance',
                style: TextStyle(fontSize: 16, fontWeight: FontWeight.w700),
              ),
              const SizedBox(height: 8),
              _ThemeOption(
                label: 'System',
                selected: widget.themeMode == ThemeMode.system,
                onTap: () {
                  widget.onThemeModeChanged(ThemeMode.system);
                  Navigator.pop(ctx);
                },
              ),
              _ThemeOption(
                label: 'Light',
                selected: widget.themeMode == ThemeMode.light,
                onTap: () {
                  widget.onThemeModeChanged(ThemeMode.light);
                  Navigator.pop(ctx);
                },
              ),
              _ThemeOption(
                label: 'Dark',
                selected: widget.themeMode == ThemeMode.dark,
                onTap: () {
                  widget.onThemeModeChanged(ThemeMode.dark);
                  Navigator.pop(ctx);
                },
              ),
              const SizedBox(height: 16),
            ],
          ),
        );
      },
    );
  }
}

class _ThemeOption extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;

  const _ThemeOption({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    return ListTile(
      title: Text(label),
      trailing: selected
          ? const Icon(Icons.check, color: AppColors.primary)
          : null,
      onTap: onTap,
    );
  }
}

class _SettingsGroup extends StatelessWidget {
  final List<Widget> children;
  final Color surface;
  final Color outline;

  const _SettingsGroup({
    required this.children,
    required this.surface,
    required this.outline,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      decoration: BoxDecoration(
        color: surface,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: outline),
      ),
      child: Column(children: children),
    );
  }
}

class _SettingsRow extends StatelessWidget {
  final IconData icon;
  final Color iconBg;
  final Color iconColor;
  final String title;
  final String subtitle;
  final Widget trailing;
  final Color onSurface2;

  const _SettingsRow({
    required this.icon,
    required this.iconBg,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.trailing,
    required this.onSurface2,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: iconBg,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Icon(icon, size: 18, color: iconColor),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  subtitle,
                  style: TextStyle(fontSize: 11, color: onSurface2),
                ),
              ],
            ),
          ),
          trailing,
        ],
      ),
    );
  }
}
