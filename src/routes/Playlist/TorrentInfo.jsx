import { X } from "lucide-react";
import { observer } from "mobx-react-lite";
import natsort from "natsort";
import React, { useEffect, useState } from "react";
import { CoverImage } from "~/components/CoverImage";
import { Nav } from "~/components/layout/Nav";
import { Button } from "~/components/ui/button";
import { comparePath } from "~/utils";
import { COMBINED_FILES_PREFIX } from "./store";
import { formatBytes } from "./utils";

const getLabel = (file) => {
	if (file.state === "loading") {
		return "loading";
	}
	if (file.cached) {
		if (file.isCombined) {
			const [start, end] = file.originalIndexes;
			return `Combined (${end - start + 1} files)`;
		}
		return "loaded";
	}
	return formatBytes(file.length);
};

const stripCombinedPrefix = (path) => {
	if (path[0] === COMBINED_FILES_PREFIX) {
		return path.slice(1);
	}
	return path;
};

const loadAndSortFiles = async (store, ih) => {
	if (!ih) return [];
	const files = await store.getAllTorrentFiles(ih);
	files.sort((a, b) => {
		const aPath = stripCombinedPrefix(a.path).join("/");
		const bPath = stripCombinedPrefix(b.path).join("/");
		return natsort()(aPath, bPath);
	});
	return files;
};

export const TorrentInfo = observer(({ store, showCover }) => {
	const { ih, torrentInfo, setTorrentInfo, currentFile, setCurrentFile } =
		store;
	const f = torrentInfo.files;
	const [allFiles, setAllFiles] = useState([]);

	useEffect(() => {
		setTorrentInfo(ih);
	}, [ih, setTorrentInfo]);

	const updateFiles = async () => {
		const files = await loadAndSortFiles(store, ih);
		setAllFiles(files);
	};

	useEffect(() => {
		updateFiles();
	}, [ih, store.torrentInfo]);

	const handleDelete = async (file) => {
		const success = await store.removeFile(ih, file);
		if (success) {
			updateFiles();
		}
	};

	const handleClick = (file) => {
		setCurrentFile(file);
	};

	return (
		<div className="flex flex-col h-full">
			<Nav>
				<div className="flex-1">
					<div className="font-bold text-lg mt-2.5">{torrentInfo.name}</div>
				</div>
				{showCover && (
					<CoverImage
						ih={ih}
						files={allFiles}
						name={torrentInfo.name}
						normalizePathParts={stripCombinedPrefix}
						className="w-28 h-28"
						placeholderClassName="text-xs text-[var(--text-secondary)]"
						loadingLabel="Loading cover..."
					/>
				)}
			</Nav>
			<div className="flex-1 overflow-auto mt-2.5 touch-pan-y">
				<div>
					{allFiles.map((file, i) => {
						const { path } = file;
						const displayPath = stripCombinedPrefix(path).join("/");
						const currentStyle = comparePath(path, currentFile.path)
							? "bg-gray-200"
							: "";
						return (
							<div
								key={path.join("/")}
								className={`flex justify-between items-center p-2 cursor-pointer hover:bg-gray-100 ${currentStyle}`}
								onClick={() => handleClick(file)}
							>
								<div className="truncate flex-1">{displayPath}</div>
								<div className="flex items-center">
									<div className="text-sm text-gray-500 mr-2">
										{getLabel(file)}
									</div>
									{file.cached && (
										<Button
											variant="ghost"
											size="icon"
											onClick={(e) => {
												e.stopPropagation();
												handleDelete(file);
											}}
											className="text-red-500 hover:text-red-700 hover:bg-red-50"
											title="Delete"
										>
											<X className="h-4 w-4" />
										</Button>
									)}
								</div>
							</div>
						);
					})}
					<CleanBookDataButtons store={store} allFiles={allFiles} />
				</div>
			</div>
		</div>
	);
});

export const CleanBookDataButtons = observer(({ store, allFiles }) => {
	const { torrentInfo, cleanBookData, removeBook, ih } = store;
	const cachedPartsLength = allFiles.reduce(
		(total, { cached, length }) => (!cached ? total : total + length),
		0,
	);

	const clean = () =>
		window.confirm("Are you sure to delete all downloaded book parts?")
			? cleanBookData(ih)
			: null;

	const remove = () =>
		window.confirm("Are you sure to remove this book from library?")
			? removeBook(ih).then(
					(ok) => ok && window.history.pushState(null, null, "/"),
				)
			: null;

	return (
		<div className="flex flex-col">
			<div
				onClick={clean}
				className="flex justify-center py-2 cursor-pointer text-[#2f37ff] font-medium text-sm opacity-50 active:opacity-100"
			>
				Clean book data ({formatBytes(cachedPartsLength)})
			</div>
			<div
				onClick={remove}
				className="flex justify-center py-2 cursor-pointer text-[#2f37ff] font-medium text-sm opacity-50 active:opacity-100"
			>
				Remove Book from Library
			</div>
		</div>
	);
});
