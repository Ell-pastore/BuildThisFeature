import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';
import '../widgets/storage_hero.dart';
import '../widgets/ai_insight_card.dart';
import '../widgets/file_tile.dart';

/// Screen 1 — Home · Storage Overview.
class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      color: cs.surface,
      child: SafeArea(
        bottom: false,
        child: Stack(
          children: [
            Column(
              children: [
                const AppStatusBar(),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                  child: Row(
                    children: [
                      const Expanded(
                        child: Text(
                          'Files',
                          style: TextStyle(
                            fontSize: 22,
                            fontWeight: FontWeight.w700,
                            letterSpacing: -0.2,
                          ),
                        ),
                      ),
                      IconButton(onPressed: () {}, icon: const Icon(Icons.search)),
                      IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert)),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
                    children: [
                      const StorageHero(
                        usedGb: 118.2,
                        totalGb: 128,
                        freeGb: 9.8,
                        segments: [
                          StorageSegment(0.38, Color(0xFFFDE68A)),
                          StorageSegment(0.22, Color(0xFFA7F3D0)),
                          StorageSegment(0.18, Color(0xFFC4B5FD)),
                          StorageSegment(0.14, Color(0xFFF9A8D4)),
                          StorageSegment(0.08, Color(0x33FFFFFF)),
                        ],
                        legend: [
                          (color: Color(0xFFFDE68A), label: 'Photos 45 GB'),
                          (color: Color(0xFFA7F3D0), label: 'Docs 26 GB'),
                          (color: Color(0xFFC4B5FD), label: 'Apps 21 GB'),
                          (color: Color(0xFFF9A8D4), label: 'System 17 GB'),
                        ],
                      ),
                      const SizedBox(height: 12),
                      const AiInsightCard(
                        prefix: 'Tip:',
                        body: '23 duplicate photos found. Want me to clean them up?',
                      ),
                      const SizedBox(height: 14),
                      Row(
                        children: [
                          Expanded(
                            child: _QuickActionTile(
                              icon: Icons.check_circle_outline,
                              iconBg: const Color(0xFFDCFCE7),
                              iconColor: AppColors.success,
                              label: 'Clean up',
                              sub: 'Free 4.2 GB',
                            ),
                          ),
                          const SizedBox(width: 10),
                          Expanded(
                            child: _QuickActionTile(
                              icon: Icons.download_outlined,
                              iconBg: const Color(0xFFDBEAFE),
                              iconColor: AppColors.docBlue,
                              label: 'Transfer',
                              sub: 'To cloud',
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 18),
                      Row(
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: [
                          const Text(
                            'Recent',
                            style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                          ),
                          Text(
                            'See all',
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: cs.primary,
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 8),
                      Container(
                        padding: const EdgeInsets.symmetric(horizontal: 14),
                        decoration: BoxDecoration(
                          color: cs.surface,
                          border: Border.all(color: cs.outline),
                          borderRadius: BorderRadius.circular(18),
                        ),
                        child: const Column(
                          children: [
                            _FileDivider(),
                            FileTile(
                              name: 'CS-Lecture-Notes-W3.pdf',
                              meta: 'Today · 9:14 · 2.4 MB',
                              type: FileType.pdf,
                            ),
                            _FileDivider(),
                            FileTile(
                              name: 'IMG_2409.heic',
                              meta: 'Today · 8:02 · 3.8 MB',
                              type: FileType.image,
                            ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
            Positioned(
              right: 16,
              bottom: 86,
              child: _GradientFab(icon: Icons.mic, onPressed: () {}),
            ),
          ],
        ),
      ),
    );
  }
}

class _QuickActionTile extends StatelessWidget {
  const _QuickActionTile({
    required this.icon,
    required this.iconBg,
    required this.iconColor,
    required this.label,
    required this.sub,
  });
  final IconData icon;
  final Color    iconBg;
  final Color    iconColor;
  final String   label;
  final String   sub;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(16),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: iconBg,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: iconColor, size: 18),
          ),
          const SizedBox(height: 6),
          Text(label, style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600)),
          Text(sub,
              style: TextStyle(
                fontSize: 10,
                color: cs.onSurface.withOpacity(0.55),
              )),
        ],
      ),
    );
  }
}

class _GradientFab extends StatelessWidget {
  const _GradientFab({required this.icon, required this.onPressed});
  final IconData icon;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 56,
      height: 56,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(18),
        gradient: const LinearGradient(
          colors: [Color(0xFF4F46E5), Color(0xFF7C3AED)],
        ),
        boxShadow: const [
          BoxShadow(color: Color(0x554F46E5), blurRadius: 20, offset: Offset(0, 8)),
        ],
      ),
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(18),
          onTap: onPressed,
          child: Icon(icon, color: Colors.white),
        ),
      ),
    );
  }
}

class _FileDivider extends StatelessWidget {
  const _FileDivider();
  @override
  Widget build(BuildContext context) {
    return Divider(
      height: 1,
      thickness: 1,
      color: Theme.of(context).colorScheme.outline,
    );
  }
}
