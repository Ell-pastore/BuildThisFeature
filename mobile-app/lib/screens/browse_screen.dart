import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/app_status_bar.dart';
import '../widgets/search_pill_bar.dart';
import '../widgets/pill_chip.dart';

/// Screen 2 — Browse · Smart Categories.
class BrowseScreen extends StatelessWidget {
  const BrowseScreen({super.key});

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
                          'Browse',
                          style: TextStyle(
                              fontSize: 22, fontWeight: FontWeight.w700, letterSpacing: -0.2),
                        ),
                      ),
                      IconButton(onPressed: () {}, icon: const Icon(Icons.menu)),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(16, 4, 16, 96),
                    children: [
                      const SearchPillBar(
                          placeholder: "Smart search: 'tax docs from 2024'"),
                      const SizedBox(height: 12),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(children: const [
                          PillChip(label: 'Smart',      active: true),
                          SizedBox(width: 6),
                          PillChip(label: 'Recent'),
                          SizedBox(width: 6),
                          PillChip(label: 'Starred'),
                          SizedBox(width: 6),
                          PillChip(label: 'Downloads'),
                        ]),
                      ),
                      const SizedBox(height: 14),
                      GridView(
                        shrinkWrap: true,
                        physics: const NeverScrollableScrollPhysics(),
                        gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                          crossAxisCount: 2,
                          crossAxisSpacing: 10,
                          mainAxisSpacing: 10,
                          childAspectRatio: 1.45,
                        ),
                        children: const [
                          _CategoryCard(icon: Icons.picture_as_pdf,         color: AppColors.error,         bg: Color(0xFFFEE2E2), label: 'Documents', count: 142,    size: '26.4 GB'),
                          _CategoryCard(icon: Icons.image_outlined,         color: AppColors.docBlue,       bg: Color(0xFFDBEAFE), label: 'Photos',    count: '3,847', size: '45.2 GB'),
                          _CategoryCard(icon: Icons.play_circle_outline,     color: Color(0xFFD97706),       bg: Color(0xFFFEF3C7), label: 'Videos',    count: 218,     size: '31.6 GB'),
                          _CategoryCard(icon: Icons.music_note,             color: Color(0xFF9333EA),       bg: Color(0xFFE9D5FF), label: 'Audio',     count: 86,      size: '4.7 GB'),
                          _CategoryCard(icon: Icons.android,                color: AppColors.success,       bg: Color(0xFFDCFCE7), label: 'APKs',      count: 52,      size: '2.1 GB'),
                          _CategoryCard(icon: Icons.chat_bubble_outline,    color: AppColors.secondary,     bg: Color(0xFFD8F5F4), label: 'Chats',     count: 14,      size: '812 MB'),
                        ],
                      ),
                      const SizedBox(height: 18),
                      const Text(
                        'Smart Folders',
                        style: TextStyle(fontSize: 14, fontWeight: FontWeight.w700),
                      ),
                      const SizedBox(height: 10),
                      const _SmartFolderTile(
                        gradient: [Color(0xFFF59E0B), Color(0xFFEF4444)],
                        icon: Icons.star,
                        name: 'Large files (> 25 MB)',
                        meta: 'AI grouped · 28 files · 1.8 GB',
                      ),
                      const _SmartFolderTile(
                        gradient: [Color(0xFF22C55E), Color(0xFF16A34A)],
                        icon: Icons.refresh,
                        name: 'Duplicates',
                        meta: 'Detected · 23 photos · 312 MB',
                      ),
                    ],
                  ),
                ),
              ],
            ),
            Positioned(
              right: 16,
              bottom: 86,
              child: Container(
                width: 48,
                height: 48,
                decoration: BoxDecoration(
                  color: cs.surface,
                  border: Border.all(color: cs.outline),
                  borderRadius: BorderRadius.circular(14),
                  boxShadow: const [
                    BoxShadow(color: Color(0x14000000), blurRadius: 12, offset: Offset(0, 4)),
                  ],
                ),
                child: const Icon(Icons.add, color: AppColors.primary),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({
    required this.icon,
    required this.color,
    required this.bg,
    required this.label,
    required this.count,
    required this.size,
  });
  final IconData icon;
  final Color    color;
  final Color    bg;
  final String   label;
  final Object   count;
  final String   size;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(12)),
                child: Icon(icon, color: color, size: 20),
              ),
              Text(
                '$count',
                style: TextStyle(
                  fontSize: 11,
                  color: cs.onSurface.withOpacity(0.55),
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
          const Spacer(),
          Text(label, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
          const SizedBox(height: 2),
          Text(size,
              style: TextStyle(
                fontSize: 11,
                color: cs.onSurface.withOpacity(0.6),
              )),
        ],
      ),
    );
  }
}

class _SmartFolderTile extends StatelessWidget {
  const _SmartFolderTile({
    required this.icon,
    required this.gradient,
    required this.name,
    required this.meta,
  });
  final IconData    icon;
  final List<Color> gradient;
  final String      name;
  final String      meta;

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.only(bottom: 8),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: cs.surface,
        border: Border.all(color: cs.outline),
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: [
          Container(
            width: 40,
            height: 40,
            decoration: BoxDecoration(
              gradient: LinearGradient(colors: gradient),
              borderRadius: BorderRadius.circular(10),
            ),
            child: Icon(icon, color: Colors.white, size: 18),
          ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(name, style: const TextStyle(fontSize: 13, fontWeight: FontWeight.w600)),
                Text(meta,
                    style: TextStyle(
                      fontSize: 11,
                      color: cs.onSurface.withOpacity(0.55),
                    )),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
