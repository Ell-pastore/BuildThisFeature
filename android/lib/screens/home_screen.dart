import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../widgets/common_widgets.dart';
import '../models/dummy_data.dart';
import 'ai_chat_screen.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;

    return Scaffold(
      appBar: AppBar(
        title: const Text('Files'),
        actions: [
          IconButton(onPressed: () {}, icon: const Icon(Icons.search)),
          IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert)),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 100),
        children: [
          // Storage Hero
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              gradient: LinearGradient(
                colors: isDark
                    ? [
                        const Color(0xFF312E81),
                        const Color(0xFF5B21B6),
                        const Color(0xFF831843)
                      ]
                    : [
                        const Color(0xFF4F46E5),
                        const Color(0xFF7C3AED),
                        const Color(0xFFEC4899)
                      ],
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
              ),
              borderRadius: BorderRadius.circular(22),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Text(
                  'STORAGE',
                  style: TextStyle(
                    color: Colors.white70,
                    fontSize: 13,
                    fontWeight: FontWeight.w500,
                  ),
                ),
                const SizedBox(height: 6),
                RichText(
                  text: const TextSpan(
                    children: [
                      TextSpan(
                        text: '118.2 ',
                        style: TextStyle(
                          fontSize: 32,
                          fontWeight: FontWeight.w700,
                          color: Colors.white,
                        ),
                      ),
                      TextSpan(
                        text: 'GB used',
                        style: TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.w500,
                          color: Colors.white70,
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 4),
                const Text(
                  'of 128 GB · 9.8 GB free',
                  style: TextStyle(color: Colors.white70, fontSize: 12),
                ),
                const SizedBox(height: 14),
                ClipRRect(
                  borderRadius: BorderRadius.circular(99),
                  child: const SizedBox(
                    height: 8,
                    child: Row(
                      children: [
                        Expanded(
                            flex: 38,
                            child: ColoredBox(color: Color(0xFFFDE68A))),
                        Expanded(
                            flex: 22,
                            child: ColoredBox(color: Color(0xFFA7F3D0))),
                        Expanded(
                            flex: 18,
                            child: ColoredBox(color: Color(0xFFC4B5FD))),
                        Expanded(
                            flex: 14,
                            child: ColoredBox(color: Color(0xFFF9A8D4))),
                        Expanded(
                            flex: 8,
                            child: ColoredBox(color: Color(0x66FFFFFF))),
                      ],
                    ),
                  ),
                ),
                const SizedBox(height: 12),
                const Wrap(
                  spacing: 16,
                  runSpacing: 6,
                  children: [
                    _Legend(color: Color(0xFFFDE68A), label: 'Photos 45 GB'),
                    _Legend(color: Color(0xFFA7F3D0), label: 'Docs 26 GB'),
                    _Legend(color: Color(0xFFC4B5FD), label: 'Apps 21 GB'),
                    _Legend(color: Color(0xFFF9A8D4), label: 'System 17 GB'),
                  ],
                ),
              ],
            ),
          ),

          const SizedBox(height: 14),

          // AI Tip
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              color: isDark ? AppColors.darkSurface : Colors.white,
              borderRadius: BorderRadius.circular(16),
              border: Border.all(color: AppColors.primary),
            ),
            child: Row(
              children: [
                Container(
                  width: 32,
                  height: 32,
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      colors: [Color(0xFF4F46E5), Color(0xFFA855F7)],
                    ),
                    shape: BoxShape.circle,
                  ),
                  child: const Icon(Icons.auto_awesome,
                      color: Colors.white, size: 16),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: RichText(
                    text: TextSpan(
                      style: TextStyle(
                        fontSize: 12,
                        color: isDark
                            ? AppColors.darkOnSurface2
                            : AppColors.lightOnSurface2,
                        height: 1.4,
                      ),
                      children: const [
                        TextSpan(
                          text: 'Tip: ',
                          style: TextStyle(
                            fontWeight: FontWeight.w700,
                            color: AppColors.primary,
                          ),
                        ),
                        TextSpan(
                          text:
                              '23 duplicate photos found. Want me to clean them up?',
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 14),

          // Quick Actions
          Row(
            children: [
              Expanded(
                child: _QuickAction(
                  icon: Icons.check_circle_outline,
                  iconBg: isDark
                      ? const Color(0xFF14532D)
                      : const Color(0xFFDCFCE7),
                  iconColor: isDark
                      ? const Color(0xFF86EFAC)
                      : const Color(0xFF16A34A),
                  label: 'Clean up',
                  sub: 'Free 4.2 GB',
                ),
              ),
              const SizedBox(width: 10),
              Expanded(
                child: _QuickAction(
                  icon: Icons.cloud_upload_outlined,
                  iconBg: isDark
                      ? const Color(0xFF1E3A8A)
                      : const Color(0xFFDBEAFE),
                  iconColor: isDark
                      ? const Color(0xFF93C5FD)
                      : const Color(0xFF2563EB),
                  label: 'Transfer',
                  sub: 'To cloud',
                ),
              ),
            ],
          ),

          SectionHeader(
            title: 'Recent',
            actionLabel: 'See all',
            onAction: () {},
          ),

          Card(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: Column(
                children:
                    DummyData.recentFiles.map((f) => FileRow(file: f)).toList(),
              ),
            ),
          ),
        ],
      ),
      floatingActionButton: FloatingActionButton(
        onPressed: () {
          Navigator.push(
            context,
            MaterialPageRoute(builder: (_) => const AiChatScreen()),
          );
        },
        child: const Icon(Icons.auto_awesome),
      ),
    );
  }
}

class _Legend extends StatelessWidget {
  final Color color;
  final String label;
  const _Legend({required this.color, required this.label});

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(color: color, shape: BoxShape.circle),
        ),
        const SizedBox(width: 6),
        Text(
          label,
          style: const TextStyle(color: Colors.white70, fontSize: 11),
        ),
      ],
    );
  }
}

class _QuickAction extends StatelessWidget {
  final IconData icon;
  final Color iconBg;
  final Color iconColor;
  final String label;
  final String sub;

  const _QuickAction({
    required this.icon,
    required this.iconBg,
    required this.iconColor,
    required this.label,
    required this.sub,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    return Container(
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: isDark ? AppColors.darkSurface : Colors.white,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(
          color: isDark ? AppColors.darkOutline : AppColors.lightOutline,
        ),
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
          Text(
            label,
            style: const TextStyle(fontSize: 12, fontWeight: FontWeight.w600),
          ),
          Text(
            sub,
            style: TextStyle(
              fontSize: 10,
              color: isDark
                  ? AppColors.darkOnSurface2
                  : const Color(0xFF8E92A0),
            ),
          ),
        ],
      ),
    );
  }
}
