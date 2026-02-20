"""Git operations for workspace endpoints."""
import os
import re
import subprocess
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.logging_config import get_logger
from ._common import RUNS_DIR, _safe_path, _add_credentials

logger = get_logger(__name__)
router = APIRouter()


def _git_push(workspace_path: str, branch: str = "main", force: bool = False) -> dict:
    """
    Push to remote repository with detailed result.
    
    Returns dict with:
        - success: bool
        - commits_pushed: int (optional)
        - remote_commit_hash: str (optional)
        - branch: str (optional)
        - remote_url: str (optional)
        - error: str (optional)
        - auth_error: bool
    """
    logger.debug(f"Git push: workspace={workspace_path}, branch={branch}, force={force}")
    
    workspace = Path(workspace_path)
    
    if not (workspace / '.git').exists():
        logger.debug(f"Not a git repository: {workspace_path}")
        return {
            "success": False,
            "error": "Not a git repository",
            "auth_error": False,
        }
    
    try:
        # Check if remote exists
        try:
            remote_result = subprocess.run(
                ['git', 'remote', 'get-url', 'origin'],
                cwd=workspace,
                capture_output=True,
                text=True,
                check=True
            )
            remote_url = remote_result.stdout.strip()
        except subprocess.CalledProcessError:
            return {
                "success": False,
                "error": "No remote origin configured",
                "auth_error": False,
            }
        
        # Get current commit before push
        before_commit_result = subprocess.run(
            ['git', 'rev-parse', 'HEAD'],
            cwd=workspace,
            capture_output=True,
            text=True,
            check=True
        )
        before_commit = before_commit_result.stdout.strip()
        
        # Count commits ahead of remote
        commits_ahead = 0
        try:
            ahead_result = subprocess.run(
                ['git', 'rev-list', '--count', f'origin/{branch}..HEAD'],
                cwd=workspace,
                capture_output=True,
                text=True,
                stderr=subprocess.DEVNULL
            )
            if ahead_result.returncode == 0:
                commits_ahead = int(ahead_result.stdout.strip())
        except Exception:
            # Remote might not have branch yet, count all commits
            try:
                all_commits_result = subprocess.run(
                    ['git', 'rev-list', '--count', 'HEAD'],
                    cwd=workspace,
                    capture_output=True,
                    text=True,
                    check=True
                )
                commits_ahead = int(all_commits_result.stdout.strip())
            except Exception:
                commits_ahead = 0
        
        logger.debug(f"Commits ahead of remote: {commits_ahead}")
        
        # Add credentials to remote URL temporarily
        authenticated_url = _add_credentials(remote_url)
        subprocess.run(
            ['git', 'remote', 'set-url', 'origin', authenticated_url],
            cwd=workspace,
            capture_output=True,
            check=True
        )
        
        # Perform push
        try:
            push_cmd = ['git', 'push']
            if force:
                push_cmd.append('--force')
            push_cmd.extend(['-u', 'origin', branch])
            
            subprocess.run(
                push_cmd,
                cwd=workspace,
                capture_output=True,
                text=True,
                check=True,
                timeout=30,
                env={
                    **os.environ,
                    'GIT_TERMINAL_PROMPT': '0',  # Disable interactive prompts
                }
            )
            
            # Restore original remote URL (without credentials)
            subprocess.run(
                ['git', 'remote', 'set-url', 'origin', remote_url],
                cwd=workspace,
                capture_output=True
            )
            
            return {
                "success": True,
                "commits_pushed": commits_ahead,
                "remote_commit_hash": before_commit,
                "branch": branch,
                "remote_url": remote_url,
                "auth_error": False,
            }
            
        except subprocess.CalledProcessError as push_error:
            # Restore original remote URL on error
            try:
                subprocess.run(
                    ['git', 'remote', 'set-url', 'origin', remote_url],
                    cwd=workspace,
                    capture_output=True
                )
            except Exception:
                pass
            
            error_msg = push_error.stderr if push_error.stderr else str(push_error)
            logger.debug(f"Git push failed: {error_msg}")
            
            # Detect authentication errors
            if any(phrase in error_msg.lower() for phrase in [
                'authentication failed',
                'permission denied',
                'invalid credentials',
                'could not read username'
            ]):
                logger.debug("Git push auth error detected")
                return {
                    "success": False,
                    "error": "Authentication failed - check credentials",
                    "auth_error": True,
                }
            
            # Detect network errors
            if any(phrase in error_msg.lower() for phrase in [
                'connection refused',
                'could not resolve host',
                'timed out'
            ]):
                return {
                    "success": False,
                    "error": "Network error - check connection to remote",
                    "auth_error": False,
                }
            
            # Detect push rejected (need to pull first)
            if any(phrase in error_msg.lower() for phrase in ['rejected', 'non-fast-forward']):
                logger.debug("Git push rejected - remote has diverged")
                return {
                    "success": False,
                    "error": "Push rejected - remote has diverged, pull first",
                    "auth_error": False,
                }
            
            return {
                "success": False,
                "error": error_msg or "Push failed",
                "auth_error": False,
            }
    
    except Exception as err:
        logger.debug(f"Git push operation failed: {str(err)}")
        return {
            "success": False,
            "error": f"Push operation failed: {str(err)}",
            "auth_error": False,
        }


# Pydantic models

class MergeRequest(BaseModel):
    strategy: str = "merge"  # merge, squash, or rebase


class MergeResponse(BaseModel):
    success: bool
    commit_hash: Optional[str] = None
    conflicts: Optional[list[str]] = None
    error: Optional[str] = None


class PushRequest(BaseModel):
    branch: Optional[str] = "main"
    force: Optional[bool] = False


class PushResponse(BaseModel):
    success: bool
    commits_pushed: Optional[int] = None
    remote_commit_hash: Optional[str] = None
    branch: Optional[str] = None
    remote_url: Optional[str] = None
    error: Optional[str] = None
    auth_error: bool = False


# Git endpoints

@router.get("/{run_id}/git/status")
async def get_git_status(run_id: str):
    """Get git branch and working tree status for a run."""
    logger.debug(f"Getting git status for run_id={run_id}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git repository for run_id={run_id}")
        return {
            "run_id": run_id,
            "is_repo": False,
            "branch": None,
            "error": "Not a git repository"
        }
    
    try:
        # Get current branch
        branch_result = subprocess.run(
            ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        current_branch = branch_result.stdout.strip()
        
        # Get tracking branch
        tracking_result = subprocess.run(
            ['git', 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'],
            cwd=base,
            capture_output=True,
            text=True
        )
        tracking_branch = tracking_result.stdout.strip() if tracking_result.returncode == 0 else None
        
        # Check if working tree is clean
        status_result = subprocess.run(
            ['git', 'status', '--porcelain'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        is_clean = len(status_result.stdout.strip()) == 0
        
        # Count uncommitted changes
        changes = []
        if not is_clean:
            for line in status_result.stdout.strip().split('\n'):
                if line:
                    status_code = line[:2]
                    filename = line[3:]
                    changes.append({
                        'status': status_code.strip(),
                        'file': filename
                    })
        
        # Get ahead/behind counts if tracking branch exists
        ahead = 0
        behind = 0
        if tracking_branch:
            try:
                rev_list_result = subprocess.run(
                    ['git', 'rev-list', '--left-right', '--count', f'{current_branch}...{tracking_branch}'],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True
                )
                counts = rev_list_result.stdout.strip().split()
                if len(counts) == 2:
                    ahead = int(counts[0])
                    behind = int(counts[1])
            except Exception:
                pass
        
        # Get last commit info
        last_commit = None
        try:
            last_commit_result = subprocess.run(
                ['git', 'log', '-1', '--format=%H|%h|%at|%s'],
                cwd=base,
                capture_output=True,
                text=True,
                check=True
            )
            last_commit_parts = last_commit_result.stdout.strip().split('|')
            if len(last_commit_parts) == 4:
                last_commit = {
                    'hash': last_commit_parts[0],
                    'short_hash': last_commit_parts[1],
                    'timestamp': int(last_commit_parts[2]),
                    'subject': last_commit_parts[3]
                }
        except Exception:
            pass
        
        return {
            "run_id": run_id,
            "is_repo": True,
            "branch": current_branch,
            "tracking_branch": tracking_branch,
            "is_clean": is_clean,
            "ahead": ahead,
            "behind": behind,
            "uncommitted_changes": len(changes),
            "changes": changes[:10],  # Limit to first 10 for UI
            "last_commit": last_commit
        }
    
    except subprocess.CalledProcessError as e:
        logger.debug(f"Git command failed for run_id={run_id}: {e.stderr}")
        return {
            "run_id": run_id,
            "is_repo": True,
            "error": f"Git command failed: {e.stderr if e.stderr else 'unknown error'}"
        }
    except Exception as e:
        return {
            "run_id": run_id,
            "is_repo": True,
            "error": f"Failed to get git status: {str(e)}"
        }


@router.get("/{run_id}/git/history")
async def get_git_history(run_id: str, limit: int = 50, offset: int = 0):
    """Get git commit history for a run workspace."""
    logger.debug(f"Getting git history for run_id={run_id}, limit={limit}, offset={offset}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git repository for run_id={run_id}")
        return {"run_id": run_id, "commits": [], "total": 0}
    
    try:
        # Format: hash|short|author|email|timestamp|subject
        result = subprocess.run(
            ['git', 'log', f'--skip={offset}', f'-n{limit}', '--format=%H|%h|%an|%ae|%at|%s', '--shortstat'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        commits = []
        lines = result.stdout.strip().split('\n')
        i = 0
        
        while i < len(lines):
            if not lines[i].strip():
                i += 1
                continue
            
            # Parse commit line
            parts = lines[i].split('|')
            if len(parts) != 6:
                i += 1
                continue
            
            commit = {
                'hash': parts[0],
                'short_hash': parts[1],
                'author': parts[2],
                'email': parts[3],
                'timestamp': int(parts[4]),
                'subject': parts[5],
            }
            
            # Extract step info from commit message
            # Format: "step/03 (coder-agent): Added tests"
            subject = parts[5]
            match = re.match(r'step/(\S+)\s+\(([^)]+)\):\s*(.*)', subject)
            if match:
                commit['step_id'] = match.group(1)
                commit['agent_id'] = match.group(2)
                commit['summary'] = match.group(3)
            
            # Parse stats from next line if it exists
            if i + 1 < len(lines) and 'file' in lines[i + 1]:
                stat_line = lines[i + 1]
                # Example: " 3 files changed, 42 insertions(+), 12 deletions(-)"
                files_match = re.search(r'(\d+)\s+files?\s+changed', stat_line)
                insert_match = re.search(r'(\d+)\s+insertion', stat_line)
                delete_match = re.search(r'(\d+)\s+deletion', stat_line)
                
                commit['stats'] = {
                    'files': int(files_match.group(1)) if files_match else 0,
                    'insertions': int(insert_match.group(1)) if insert_match else 0,
                    'deletions': int(delete_match.group(1)) if delete_match else 0,
                }
                i += 1
            else:
                # No stats means no files changed
                commit['stats'] = {
                    'files': 0,
                    'insertions': 0,
                    'deletions': 0,
                }
            
            commits.append(commit)
            i += 1
        
        return {
            "run_id": run_id,
            "commits": commits,
            "total": len(commits)
        }
    
    except subprocess.CalledProcessError as e:
        raise HTTPException(status_code=500, detail=f"Git command failed: {e.stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read git log: {str(e)}")


@router.get("/{run_id}/git/show/{commit_hash}/{file_path:path}")
async def get_file_at_commit(run_id: str, commit_hash: str, file_path: str):
    """Get file content as it existed at a specific commit."""
    logger.debug(f"Getting file at commit for run_id={run_id}, commit={commit_hash}, path={file_path}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git repository for run_id={run_id}")
        raise HTTPException(status_code=404, detail="Not a git repository")
    
    # Validate commit hash (allow HEAD and SHA-1 hashes)
    if commit_hash != "HEAD" and not re.match(r'^[a-f0-9]{7,40}$', commit_hash):
        logger.debug(f"Invalid commit hash: {commit_hash}")
        raise HTTPException(status_code=400, detail="Invalid commit hash")
    
    try:
        # Get file content at commit
        result = subprocess.run(
            ['git', 'show', f'{commit_hash}:{file_path}'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        content = result.stdout
        
        # Get commit info
        commit_info_result = subprocess.run(
            ['git', 'show', '--format=%H|%h|%an|%at|%s', '--no-patch', commit_hash],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        parts = commit_info_result.stdout.strip().split('|')
        commit_info = None
        if len(parts) >= 5:
            commit_info = {
                'hash': parts[0],
                'short_hash': parts[1],
                'author': parts[2],
                'timestamp': int(parts[3]),
                'subject': parts[4]
            }
        
        # Detect language from file extension for syntax highlighting
        ext = file_path.rsplit('.', 1)[-1].lower() if '.' in file_path else ''
        language_map = {
            'py': 'python',
            'js': 'javascript',
            'ts': 'typescript',
            'tsx': 'typescript',
            'jsx': 'javascript',
            'json': 'json',
            'yaml': 'yaml',
            'yml': 'yaml',
            'md': 'markdown',
            'html': 'html',
            'css': 'css',
            'sql': 'sql',
            'sh': 'bash',
            'bash': 'bash',
            'go': 'go',
            'rs': 'rust',
            'rb': 'ruby',
            'java': 'java',
            'cpp': 'cpp',
            'c': 'c',
            'h': 'c',
        }
        detected_language = language_map.get(ext, 'text')
        
        return {
            "run_id": run_id,
            "path": file_path,
            "commit": commit_info,
            "content": content,
            "size": len(content),
            "language": detected_language
        }
    
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.lower() if e.stderr else ''
        if 'does not exist' in error_msg or 'exists on disk' in error_msg or 'fatal: path' in error_msg:
            raise HTTPException(
                status_code=404, 
                detail=f"File '{file_path}' not found at commit {commit_hash}"
            )
        if 'invalid object' in error_msg or 'bad revision' in error_msg:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid commit hash: {commit_hash}"
            )
        raise HTTPException(status_code=500, detail=f"Git command failed: {e.stderr}")
    except UnicodeDecodeError:
        raise HTTPException(status_code=415, detail="Binary file, cannot display as text")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {str(e)}")


@router.get("/{run_id}/git/file-history/{file_path:path}")
async def get_file_history(run_id: str, file_path: str, limit: int = 20):
    """Get commit history for a specific file."""
    logger.debug(f"Getting file history for run_id={run_id}, path={file_path}, limit={limit}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git repository for run_id={run_id}")
        raise HTTPException(status_code=404, detail="Not a git repository")
    
    try:
        # Get log for specific file
        result = subprocess.run(
            ['git', 'log', f'-n{limit}', '--format=%H|%h|%an|%at|%s', '--', file_path],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        commits = []
        for line in result.stdout.strip().split('\n'):
            if not line:
                continue
            
            parts = line.split('|')
            if len(parts) < 5:
                continue
            
            commit = {
                'hash': parts[0],
                'short_hash': parts[1],
                'author': parts[2],
                'timestamp': int(parts[3]),
                'subject': parts[4]
            }
            
            # Extract step info from commit message
            match = re.match(r'step/(\S+)\s+\(([^)]+)\):\s*(.*)', parts[4])
            if match:
                commit['step_id'] = match.group(1)
                commit['agent_id'] = match.group(2)
                commit['summary'] = match.group(3)
            
            commits.append(commit)
        
        logger.debug(f"Found {len(commits)} commits for file {file_path}")
        return {
            "run_id": run_id,
            "path": file_path,
            "commits": commits,
            "total": len(commits)
        }
    
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr.lower() if e.stderr else ''
        if 'does not exist' in error_msg or 'fatal: ambiguous argument' in error_msg:
            raise HTTPException(status_code=404, detail=f"File '{file_path}' not found in repository history")
        raise HTTPException(status_code=500, detail=f"Git command failed: {e.stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file history: {str(e)}")


@router.get("/{run_id}/git/diff/{commit_hash}")
async def get_commit_diff(run_id: str, commit_hash: str):
    """Get the diff for a specific commit."""
    logger.debug(f"Getting diff for run_id={run_id}, commit={commit_hash}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git repository for run_id={run_id}")
        raise HTTPException(status_code=404, detail="Workspace is not a git repository")
    
    # Validate commit hash (prevent injection)
    if not re.match(r'^[a-f0-9]{7,40}$', commit_hash):
        logger.debug(f"Invalid commit hash: {commit_hash}")
        raise HTTPException(status_code=400, detail="Invalid commit hash")
    
    try:
        # Get commit info
        commit_info = subprocess.run(
            ['git', 'show', '--format=%H|%h|%an|%at|%s', '--no-patch', commit_hash],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        parts = commit_info.stdout.strip().split('|')
        if len(parts) < 5:
            raise HTTPException(status_code=404, detail="Commit not found")
        
        # Get diff with unified format
        diff_result = subprocess.run(
            ['git', 'show', '--format=', '--unified=3', '--no-color', commit_hash],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        # Get list of changed files with stats
        stat_result = subprocess.run(
            ['git', 'diff-tree', '--no-commit-id', '--numstat', '-r', commit_hash],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        # Parse files from numstat output
        # Format: "additions\tdeletions\tfilename"
        files = []
        for line in stat_result.stdout.strip().split('\n'):
            if not line:
                continue
            parts = line.split('\t')
            if len(parts) == 3:
                adds_str = parts[0]
                dels_str = parts[1]
                filename = parts[2]
                
                # Handle binary files (shown as '-')
                additions = 0 if adds_str == '-' else int(adds_str)
                deletions = 0 if dels_str == '-' else int(dels_str)
                
                # Determine file status (added/deleted/modified)
                status = 'modified'
                if additions > 0 and deletions == 0:
                    status = 'added'
                elif additions == 0 and deletions > 0:
                    status = 'deleted'
                
                files.append({
                    'path': filename,
                    'additions': additions,
                    'deletions': deletions,
                    'status': status
                })
        
        return {
            'commit': {
                'hash': parts[0],
                'short_hash': parts[1],
                'author': parts[2],
                'timestamp': int(parts[3]),
                'subject': parts[4],
            },
            'files': files,
            'diff': diff_result.stdout,
        }
    
    except subprocess.CalledProcessError as e:
        if e.stderr and 'unknown revision' in e.stderr.lower():
            raise HTTPException(status_code=404, detail="Commit not found")
        raise HTTPException(status_code=500, detail=f"Git command failed: {e.stderr}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate diff: {str(e)}")


@router.post("/{run_id}/git/merge", response_model=MergeResponse)
async def merge_run_to_main(run_id: str, request: MergeRequest = MergeRequest()):
    """
    Merge a run branch back to the main branch.
    
    Supports different merge strategies:
    - merge: Creates a merge commit (default)
    - squash: Squashes all commits into one
    - rebase: Rebases run branch onto main, then fast-forwards
    
    Returns merge result with commit hash on success, or conflict list on failure.
    """
    logger.debug(f"Initiating merge for run_id={run_id}, strategy={request.strategy}")
    
    base = _safe_path(run_id)
    git_dir = base / '.git'
    
    if not git_dir.exists():
        logger.debug(f"Not a git workspace for run_id={run_id}")
        raise HTTPException(status_code=404, detail="Not a git workspace")
    
    # Validate strategy
    strategy = request.strategy.lower()
    if strategy not in ['merge', 'squash', 'rebase']:
        logger.debug(f"Invalid merge strategy: {strategy}")
        raise HTTPException(status_code=400, detail="Invalid merge strategy. Use: merge, squash, or rebase")
    
    try:
        # Get current branch
        current_branch = subprocess.run(
            ['git', 'rev-parse', '--abbrev-ref', 'HEAD'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        ).stdout.strip()
        
        # Check if main branch exists
        branches_result = subprocess.run(
            ['git', 'branch', '--list'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        if 'main' not in branches_result.stdout:
            return MergeResponse(
                success=False,
                error="Main branch not found"
            )
        
        # Already on main?
        if current_branch == 'main':
            return MergeResponse(
                success=False,
                error="Already on main branch, nothing to merge"
            )
        
        # Check if there's anything to merge
        try:
            commits_to_merge = subprocess.run(
                ['git', 'rev-list', f'main..{current_branch}'],
                cwd=base,
                capture_output=True,
                text=True,
                check=True
            ).stdout.strip()
            
            if not commits_to_merge:
                return MergeResponse(
                    success=False,
                    error="Nothing to merge - branch is up to date with main"
                )
        except subprocess.CalledProcessError:
            return MergeResponse(
                success=False,
                error="Failed to check merge status"
            )
        
        # Switch to main branch
        subprocess.run(
            ['git', 'checkout', 'main'],
            cwd=base,
            capture_output=True,
            text=True,
            check=True
        )
        
        # Perform merge based on strategy
        merge_env = {
            **os.environ,
            'GIT_AUTHOR_NAME': 'djinnbot',
            'GIT_AUTHOR_EMAIL': 'djinnbot@local',
            'GIT_COMMITTER_NAME': 'djinnbot',
            'GIT_COMMITTER_EMAIL': 'djinnbot@local',
        }
        
        try:
            if strategy == 'squash':
                # Squash merge
                subprocess.run(
                    ['git', 'merge', '--squash', current_branch],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True,
                    env=merge_env
                )
                # Commit the squashed changes
                subprocess.run(
                    ['git', 'commit', '-m', f'Squashed merge of run {run_id}'],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True,
                    env=merge_env
                )
            elif strategy == 'rebase':
                # Rebase strategy: rebase run branch onto main, then fast-forward
                subprocess.run(
                    ['git', 'checkout', current_branch],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True
                )
                subprocess.run(
                    ['git', 'rebase', 'main'],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True,
                    env=merge_env
                )
                subprocess.run(
                    ['git', 'checkout', 'main'],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True
                )
                subprocess.run(
                    ['git', 'merge', '--ff-only', current_branch],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True,
                    env=merge_env
                )
            else:  # merge (default)
                # Standard merge with merge commit
                subprocess.run(
                    ['git', 'merge', '--no-ff', '-m', f'Merge run {run_id} to main', current_branch],
                    cwd=base,
                    capture_output=True,
                    text=True,
                    check=True,
                    env=merge_env
                )
            
            # Get the new commit hash
            commit_hash = subprocess.run(
                ['git', 'rev-parse', 'HEAD'],
                cwd=base,
                capture_output=True,
                text=True,
                check=True
            ).stdout.strip()
            
            return MergeResponse(
                success=True,
                commit_hash=commit_hash
            )
            
        except subprocess.CalledProcessError as merge_error:
            # Check for conflicts
            status_result = subprocess.run(
                ['git', 'status', '--porcelain'],
                cwd=base,
                capture_output=True,
                text=True
            )
            
            # Conflict markers: UU, AA, DD, AU, UA, DU, UD
            conflict_codes = ['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']
            conflict_files = []
            
            for line in status_result.stdout.strip().split('\n'):
                if line and any(line.startswith(code) for code in conflict_codes):
                    conflict_files.append(line[3:].strip())
            
            if conflict_files:
                # Abort the merge/rebase
                try:
                    if strategy == 'rebase':
                        subprocess.run(['git', 'rebase', '--abort'], cwd=base, capture_output=True)
                    else:
                        subprocess.run(['git', 'merge', '--abort'], cwd=base, capture_output=True)
                except:
                    pass
                
                return MergeResponse(
                    success=False,
                    conflicts=conflict_files,
                    error="Merge conflicts detected"
                )
            
            # Other merge error - try to abort
            try:
                if strategy == 'rebase':
                    subprocess.run(['git', 'rebase', '--abort'], cwd=base, capture_output=True)
                else:
                    subprocess.run(['git', 'merge', '--abort'], cwd=base, capture_output=True)
            except:
                pass
            
            error_msg = merge_error.stderr if merge_error.stderr else merge_error.stdout
            return MergeResponse(
                success=False,
                error=f"Merge failed: {error_msg}"
            )
    
    except subprocess.CalledProcessError as e:
        error_msg = e.stderr if e.stderr else str(e)
        raise HTTPException(status_code=500, detail=f"Git operation failed: {error_msg}")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Merge operation failed: {str(e)}")


@router.post("/{run_id}/git/push", response_model=PushResponse)
async def push_to_remote(run_id: str, request: PushRequest = PushRequest()):
    """
    Push the workspace (run or project) to remote origin.
    
    Args:
        run_id: Run ID or project ID
        request: Push options (branch, force)
    
    Returns:
        PushResponse with success status and details
    """
    logger.debug(f"Pushing run_id={run_id} to remote, branch={request.branch}, force={request.force}")
    
    base = _safe_path(run_id)
    
    if not (base / '.git').exists():
        logger.debug(f"Workspace not a git repository for run_id={run_id}")
        raise HTTPException(status_code=400, detail="Workspace is not a git repository")
    
    # Perform git push operation
    try:
        result = _git_push(str(base), request.branch, request.force)
        return PushResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Push operation failed: {str(e)}"
        )


@router.post("/projects/{project_id}/git/push", response_model=PushResponse)
async def push_project_to_remote(project_id: str, request: PushRequest = PushRequest()):
    """
    Push a project workspace to remote origin.
    
    Args:
        project_id: Project ID
        request: Push options (branch, force)
    
    Returns:
        PushResponse with success status and details
    """
    logger.debug(f"Pushing project_id={project_id} to remote, branch={request.branch}, force={request.force}")
    
    # Project workspaces are in /data/workspaces/{project_id}
    workspaces_dir = os.getenv("WORKSPACES_DIR", "/data/workspaces")
    project_path = Path(workspaces_dir) / project_id
    
    if not project_path.exists():
        logger.debug(f"Project not found: project_id={project_id}")
        raise HTTPException(status_code=404, detail=f"Project not found: {project_id}")
    
    if not (project_path / '.git').exists():
        logger.debug(f"Project not a git repository: project_id={project_id}")
        raise HTTPException(status_code=400, detail="Project is not a git repository")
    
    # Perform git push operation
    try:
        result = _git_push(str(project_path), request.branch, request.force)
        return PushResponse(**result)
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Push operation failed: {str(e)}"
        )
