import 'package:flutter/material.dart';
import '../theme/app_colors.dart';
import '../widgets/bottom_nav.dart';
import 'home_screen.dart';
import 'browse_screen.dart';
import 'file_list_screen.dart';
import 'ai_chat_screen.dart';
import 'confirm_screen.dart';
import 'search_screen.dart';
import 'settings_screen.dart';
import 'dark_home_screen.dart';

/// Root shell — bottom-nav that swaps between the 4 main tabs.
/// Extra FloatingActionButtons in the bottom-right stack let reviewers
/// jump to the AI chat, the confirmation sheet, the file list, and the
/// dark home screen without changing tabs.
class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _tabs = <Widget>[
    HomeScreen(),
    BrowseScreen(),
    SearchScreen(),
    SettingsScreen(),
  ];

  void _push(Widget screen) {
    Navigator.of(context).push(MaterialPageRoute(builder: (_) => screen));
  }

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    return Scaffold(
      backgroundColor: cs.surface,
      body: IndexedStack(index: _index, children: _tabs),
      bottomNavigationBar: AppBottomNav(
        currentIndex: _index,
        onTap: (i) => setState(() => _index = i),
      ),
      floatingActionButton: Wrap(
        spacing: 8,
        direction: Axis.vertical,
        crossAxisAlignment: WrapCrossAlignment.end,
        children: [
          FloatingActionButton.small(
            heroTag: 'fab-ai',
            backgroundColor: cs.primaryContainer,
            onPressed: () => _push(const AiChatScreen()),
            child: Icon(Icons.auto_awesome, color: cs.primary),
          ),
          FloatingActionButton.small(
            heroTag: 'fab-confirm',
            backgroundColor: cs.surface,
            onPressed: () => _push(const ConfirmScreen()),
            child: const Icon(Icons.checklist),
          ),
          FloatingActionButton(
            heroTag: 'fab-files',
            onPressed: () => _push(const FileListScreen()),
            child: const Icon(Icons.folder_open),
          ),
          FloatingActionButton.small(
            heroTag: 'fab-dark',
            backgroundColor: Colors.black,
            onPressed: () => _push(const DarkHomeScreen()),
            child: const Icon(Icons.dark_mode, color: Colors.white),
          ),
        ],
      ),
    );
  }
}
