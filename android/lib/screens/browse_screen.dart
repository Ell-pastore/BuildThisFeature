import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/dummy_data.dart';
import '../widgets/common_widgets.dart';
import 'file_list_screen.dart';

class BrowseScreen extends StatefulWidget {
  const BrowseScreen({super.key});

  @override
  State<BrowseScreen> createState() => _BrowseScreenState();
}

class _BrowseScreenState extends State<BrowseScreen> {
  int _selectedTab = 0;
  final _tabs = ['Smart', 'Recent', 'Starred', 'Downloads'];

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;
    final onSurface2 = isDark ? AppColors.darkOnSurface2 : const Color(0xFF8E92A0);

    return Scaffold(
      appBar: AppBar(
        title: const Text('Browse'),
        actions: [
          IconButton(
            onPressed: () {},
            icon: const Icon(Icons.view_list_outlined),
          ),
        ],
      ),
      body: ListView(
        padding: const EdgeInsets.fromLTRB(16, 4, 16, 100),
        children: [
          // Search bar
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: surface,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: outline),
            ),
            child: Row(
              children: [
                Icon(Icons.search, size: 18, color: onSurface2),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    "Smart search: 'tax docs from 2024'",
                    style: TextStyle(fontSize: 13, color: onSurface2),
                  ),
                ),
              ],
            ),
          ),

          const SizedBox(height: 14),

          // Interactive Pill tabs
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: Row(
              children: List.generate(_tabs.length, (i) {
                final active = _selectedTab == i;
                return GestureDetector(
                  onTap: () => setState(() => _selectedTab = i),
                  child: Container(
                    margin: const EdgeInsets.only(right: 6),
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
                    decoration: BoxDecoration(
                      color: active
                          ? (isDark
                              ? AppColors.darkPrimary.withValues(alpha: 0.18)
                              : AppColors.primaryContainer)
                          : Colors.transparent,
                      borderRadius: BorderRadius.circular(99),
                      border: Border.all(
                        color: active ? Colors.transparent : outline,
                      ),
                    ),
                    child: Text(
                      _tabs[i],
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: active
                            ? (isDark ? AppColors.darkPrimary : AppColors.primary)
                            : onSurface2,
                      ),
                    ),
                  ),
                );
              }),
            ),
          ),

          const SizedBox(height: 14),

          // Category grid
          GridView.builder(
            shrinkWrap: true,
            physics: const NeverScrollableScrollPhysics(),
            itemCount: DummyData.categories.length,
            gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: 2,
              mainAxisSpacing: 10,
              crossAxisSpacing: 10,
              childAspectRatio: 1.35,
            ),
            itemBuilder: (context, i) {
              final cat = DummyData.categories[i];
              return GestureDetector(
                onTap: () {
                  if (cat.name == 'Documents') {
                    Navigator.push(
                      context,
                      MaterialPageRoute(builder: (_) => const FileListScreen()),
                    );
                  }
                },
                child: Container(
                  padding: const EdgeInsets.all(14),
                  decoration: BoxDecoration(
                    color: surface,
                    borderRadius: BorderRadius.circular(18),
                    border: Border.all(color: outline),
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
                            decoration: BoxDecoration(
                              color: cat.color.withValues(alpha: 0.15),
                              borderRadius: BorderRadius.circular(12),
                            ),
                            child: Icon(cat.icon, color: cat.color, size: 20),
                          ),
                          Text(
                            cat.count,
                            style: TextStyle(
                              fontSize: 11,
                              fontWeight: FontWeight.w600,
                              color: onSurface2,
                            ),
                          ),
                        ],
                      ),
                      const Spacer(),
                      Text(
                        cat.name,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        cat.size,
                        style: TextStyle(fontSize: 11, color: onSurface2),
                      ),
                    ],
                  ),
                ),
              );
            },
          ),

          const SectionHeader(title: 'Smart Folders'),

          Card(
            color: surface,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(18),
              side: BorderSide(color: outline),
            ),
            child: const Padding(
              padding: EdgeInsets.symmetric(horizontal: 14, vertical: 4),
              child: Column(
                children: [
                  FileRow(
                    file: FileItem(
                      name: 'Large files (> 25 MB)',
                      meta: 'AI grouped · 28 files · 1.8 GB',
                      type: 'PDF',
                    ),
                  ),
                  FileRow(
                    file: FileItem(
                      name: 'Duplicates',
                      meta: 'Detected · 23 photos · 312 MB',
                      type: 'IMG',
                    ),
                  ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
