import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';

/// Screen 7 — Settings · AI & Privacy.
class SettingsScreen extends StatelessWidget {
  const SettingsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      color: cs.surface,
      child: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 96),
          children: [
            const AppStatusBar(),
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 8),
              child: Row(
                children: [
                  const Expanded(
                    child: Text(
                      'Settings',
                      style: TextStyle(
                          fontSize: 22,
                          fontWeight: FontWeight.w700,
                          letterSpacing: -0.2),
                    ),
                  ),
                  IconButton(onPressed: () {}, icon: const Icon(Icons.brightness_6_outlined)),
                ],
              ),
            ),
            const SizedBox(height: 8),
            const _SectionLabel(text: 'AI & Privacy'),
            _SettingsList(
              children: [
                _SettingRow(
                  icon: Icons.lock_outline,
                  iconBg: const Color(0xFFE8E9FF),
                  iconColor: AppColors.primary,
                  title: 'On-device mode',
                  subtitle: 'AI runs locally, nothing leaves your phone',
                  trailing: const _SettingsSwitch(initial: true),
                ),
                _SettingRow(
                  icon: Icons.mic_none,
                  iconBg: const Color(0xFFDCFCE7),
                  iconColor: AppColors.success,
                  title: 'AI model',
                  subtitle: 'FileMind v3 · 4 GB',
                  trailing: const Icon(Icons.chevron_right),
                ),
                _SettingRow(
                  icon: Icons.folder_outlined,
                  iconBg: const Color(0xFFFFEDD5),
                  iconColor: AppColors.warning,
                  title: 'Allowed paths',
                  subtitle: 'Documents · Downloads · DCIM',
                  trailing: const Icon(Icons.chevron_right),
                ),
              ],
            ),
            const SizedBox(height: 14),
            const _SectionLabel(text: 'Automation'),
            _SettingsList(
              children: [
                _SettingRow(
                  icon: Icons.access_time,
                  iconBg: const Color(0xFFE8E9FF),
                  iconColor: AppColors.primary,
                  title: 'Auto-organize weekly',
                  subtitle: 'Every Sunday at 9 PM',
                  trailing: const _SettingsSwitch(initial: true),
                ),
                _SettingRow(
                  icon: Icons.copy_all_outlined,
                  iconBg: const Color(0xFFDCFCE7),
                  iconColor: AppColors.success,
                  title: 'Auto-delete duplicates',
                  subtitle: 'Confirm before deletion',
                  trailing: const _SettingsSwitch(initial: false),
                ),
              ],
            ),
            const SizedBox(height: 14),
            const _SectionLabel(text: 'General'),
            _SettingsList(
              children: [
                _SettingRow(
                  icon: Icons.palette_outlined,
                  iconBg: const Color(0xFFE8E9FF),
                  iconColor: AppColors.primary,
                  title: 'Appearance',
                  subtitle: 'System · Light · Dark',
                  trailing: const Icon(Icons.chevron_right),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  const _SectionLabel({required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 6),
        child: Text(
          text,
          style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w700),
        ),
      );
}

class _SettingsList extends StatelessWidget {
  const _SettingsList({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        children: [
          for (var i = 0; i < children.length; i++) ...[
            if (i > 0) Divider(height: 1, color: cs.outline),
            children[i],
          ],
        ],
      ),
    );
  }
}

class _SettingRow extends StatelessWidget {
  const _SettingRow({
    required this.icon,
    required this.iconBg,
    required this.iconColor,
    required this.title,
    required this.subtitle,
    required this.trailing,
  });

  final IconData icon;
  final Color    iconBg;
  final Color    iconColor;
  final String   title;
  final String   subtitle;
  final Widget   trailing;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        children: [
          Container(
            width: 32,
            height: 32,
            decoration:
                BoxDecoration(color: iconBg, borderRadius: BorderRadius.circular(8)),
            child: Icon(icon, size: 18, color: iconColor),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                const SizedBox(height: 2),
                Text(subtitle,
                    style: TextStyle(
                        fontSize: 11,
                        color: cs.onSurface.withOpacity(0.55))),
              ],
            ),
          ),
          IconTheme(
            data: IconThemeData(color: cs.onSurface.withOpacity(0.5)),
            child: trailing,
          ),
        ],
      ),
    );
  }
}

class _SettingsSwitch extends StatefulWidget {
  const _SettingsSwitch({required this.initial});
  final bool initial;

  @override
  State<_SettingsSwitch> createState() => _SettingsSwitchState();
}

class _SettingsSwitchState extends State<_SettingsSwitch> {
  late bool on = widget.initial;

  @override
  Widget build(BuildContext context) {
    return Switch(value: on, onChanged: (v) => setState(() => on = v));
  }
}
