import 'package:flutter/material.dart';
import '../theme/app_theme.dart';
import '../models/dummy_data.dart';
import '../widgets/common_widgets.dart';

class FileListScreen extends StatefulWidget {
  const FileListScreen({super.key});

  @override
  State<FileListScreen> createState() => _FileListScreenState();
}

class _FileListScreenState extends State<FileListScreen> {
  late List<FileItem> files;

  @override
  void initState() {
    super.initState();
    files = List.from(DummyData.documents);
  }

  int get selectedCount => files.where((f) => f.selected).length;

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final surface = isDark ? AppColors.darkSurface : Colors.white;
    final outline = isDark ? AppColors.darkOutline : AppColors.lightOutline;

    return Scaffold(
      appBar: AppBar(
        leading: IconButton(
          icon: const Icon(Icons.arrow_back),
          onPressed: () => Navigator.pop(context),
        ),
        title: const Text('Documents', style: TextStyle(fontSize: 18)),
        actions: [
          IconButton(onPressed: () {}, icon: const Icon(Icons.delete_outline)),
          IconButton(onPressed: () {}, icon: const Icon(Icons.more_vert)),
        ],
      ),
      body: Column(
        children: [
          if (selectedCount > 0)
            Container(
              width: double.infinity,
              color: isDark
                  ? AppColors.darkPrimary.withValues(alpha: 0.15)
                  : AppColors.primaryContainer,
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    '$selectedCount selected · 12.8 MB',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                      color: isDark ? AppColors.darkPrimary : AppColors.primary,
                    ),
                  ),
                  GestureDetector(
                    onTap: () {
                      setState(() {
                        files = files
                            .map((f) => FileItem(
                                  name: f.name,
                                  meta: f.meta,
                                  type: f.type,
                                  selected: false,
                                ))
                            .toList();
                      });
                    },
                    child: Text(
                      'Clear',
                      style: TextStyle(
                        fontSize: 12,
                        fontWeight: FontWeight.w600,
                        color: isDark ? AppColors.darkPrimary : AppColors.primary,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          Expanded(
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 160),
              itemCount: files.length,
              separatorBuilder: (_, __) => Divider(height: 1, color: outline),
              itemBuilder: (context, i) {
                final file = files[i];
                return FileRow(
                  file: file,
                  showCheckbox: true,
                  onTap: () {
                    setState(() {
                      files[i] = FileItem(
                        name: file.name,
                        meta: file.meta,
                        type: file.type,
                        selected: !file.selected,
                      );
                    });
                  },
                );
              },
            ),
          ),
        ],
      ),
      bottomSheet: selectedCount > 0
          ? Container(
              padding: const EdgeInsets.symmetric(vertical: 10, horizontal: 8),
              decoration: BoxDecoration(
                color: surface,
                border: Border(top: BorderSide(color: outline)),
              ),
              child: SafeArea(
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.spaceAround,
                  children: [
                    _ActionBtn(
                      icon: Icons.drive_file_move_outline,
                      label: 'Move',
                      primary: true,
                      isDark: isDark,
                    ),
                    _ActionBtn(
                      icon: Icons.share_outlined,
                      label: 'Share',
                      isDark: isDark,
                    ),
                    _ActionBtn(
                      icon: Icons.delete_outline,
                      label: 'Delete',
                      isDark: isDark,
                    ),
                    _ActionBtn(
                      icon: Icons.edit_outlined,
                      label: 'Rename',
                      isDark: isDark,
                    ),
                  ],
                ),
              ),
            )
          : null,
    );
  }
}

class _ActionBtn extends StatelessWidget {
  final IconData icon;
  final String label;
  final bool primary;
  final bool isDark;

  const _ActionBtn({
    required this.icon,
    required this.label,
    this.primary = false,
    required this.isDark,
  });

  @override
  Widget build(BuildContext context) {
    final color = primary
        ? (isDark ? AppColors.darkPrimary : AppColors.primary)
        : (isDark ? AppColors.darkOnSurface2 : AppColors.lightOnSurface2);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 20, color: color),
        const SizedBox(height: 4),
        Text(
          label,
          style: TextStyle(
            fontSize: 10,
            fontWeight: FontWeight.w600,
            color: color,
          ),
        ),
      ],
    );
  }
}
